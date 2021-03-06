var anonize = require('node-anonize2-relic')
var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
var underscore = require('underscore')
var uuid = require('uuid')

var v1 = {}

var server = (request, runtime) => {
  var registrarType = request.params.registrarType

  return runtime.registrars[registrarType]
}

/*
   GET /v1/registrar/{registrarType}
 */

v1.read =
{ handler: (runtime) => {
  return async (request, reply) => {
    var registrar

    registrar = server(request, runtime)
    if (!registrar) return reply(boom.notFound('unknown registrar'))

    reply(underscore.extend({ payload: registrar.payload }, registrar.publicInfo()))
  }
},

  description: 'Returns information about the registrar',
  tags: ['api'],

  validate:
    { params: { registrarType: Joi.string().valid('persona', 'viewing').required().description('the type of the registrar') } },

  response: {
    schema: Joi.object().keys({
      registrarVK: Joi.string().required().description('public key'),
      payload: Joi.object().required().description('additional information')
    })
  }
}

/*
   PATCH /v1/registrar/{registrarType}
 */

v1.update =
{ handler: (runtime) => {
  return async (request, reply) => {
    var days, fee, schema, state, registrar, validity
    var debug = braveHapi.debug(module, request)
    var payload = request.payload || {}
    var registrars = runtime.db.get('registrars', debug)

    registrar = server(request, runtime)
    if (!registrar) return reply(boom.notFound('unknown registrar'))

    days = Joi.number().integer().min(1).max(365).required()
    fee = Joi.object().keys({ USD: Joi.number().min(1).required() }).unknown(true).required()
    schema = {
      persona: Joi.object().keys({ adFree: Joi.object().keys({ days: days, fee: fee }) }).required()
    }[registrar.registrarType] || Joi.object().max(0)

    validity = Joi.validate(payload, schema)
    if (validity.error) return reply(boom.badData(validity.error))

    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { payload: payload } }
    await registrars.update({ registrarId: registrar.registrarId }, state, { upsert: false })

    registrar.payload = payload
    reply(underscore.extend({ payload: payload }, registrar.publicInfo()))
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Updates a registrar',
  tags: [ 'api' ],

  validate: {
    params: { registrarType: Joi.string().valid('persona', 'viewing').required().description('the type of the registrar') },
    payload: Joi.object().optional().description('additional information')
  },

  response: {
    schema: Joi.object().keys({
      registrarVK: Joi.string().required().description('public key'),
      payload: Joi.object().required().description('additional information')
    })
  }
}

/*
   POST /v1/registrar/{registrarType}/{uId}
 */

v1.create =
{ handler: (runtime) => {
  return async (request, reply) => {
    var entry, f, registrar, now, state, verification
    var debug = braveHapi.debug(module, request)
    var uId = request.params.uId.toLowerCase()
    var proof = request.payload.proof
    var response = {}
    var credentials = runtime.db.get('credentials', debug)

    registrar = server(request, runtime)
    if (!registrar) return reply(boom.notFound('unknown registrar'))

    entry = await credentials.findOne({ uId: uId, registrarId: registrar.registrarId })
    if (entry) return reply(boom.badData(registrar.registrarType + ' credential exists: ' + uId))

    f = {
      persona:
            async () => {
              var keychain = Joi.object().keys({
                xpub: braveJoi.string().Xpub().required(),
                path: Joi.string().optional(),
                encryptedXprv: Joi.string().optional()
              })
              var schema = Joi.object().keys({
                proof: Joi.string().required().description('credential registration request'),
// TBD: remove the backup keychain after the new client percolates out
                keychains: Joi.object().keys({ user: keychain.required(), backup: keychain.optional() })
              }).required()
              var validity = Joi.validate(request.payload, schema)

              if (validity.error) return reply(boom.badData(validity.error))
            },

      viewing:
            async () => {
              var diagnostic, surveyorIds, viewing
              var viewings = runtime.db.get('viewings', debug)

              viewing = await viewings.findOne({ uId: uId })
              if (!viewing) return reply(boom.notFound('viewingId not valid: ' + uId))

              surveyorIds = viewing.surveyorIds || []
              if (surveyorIds.length !== viewing.count) {
                diagnostic = 'surveyorIds invalid found ' + surveyorIds.length + ', expecting ' + viewing.count +
                             ', surveyorId=' + viewing.surveyorId
                runtime.notify(debug, { channel: '#devops-bot', text: 'viewing=' + uId + ': ' + diagnostic })
                return reply(boom.badImplementation(diagnostic))
              }
              underscore.extend(response, { surveyorIds: viewing.surveyorIds, satoshis: viewing.satoshis })
            }
    }[registrar.registrarType]
    if ((!!f) && (await f())) return

    try {
      now = underscore.now()
      verification = registrar.register(proof)
      runtime.newrelic.recordCustomEvent('register', {
        registrarId: registrar.registrarId,
        registrarType: registrar.registrarType,
        duration: underscore.now() - now
      })
    } catch (ex) {
      return reply(boom.badData('invalid registrar proof: ' + JSON.stringify(proof)))
    }

    f = {
      persona:
            async () => {
              var host, prefix, result, wallet
              var keychains = request.payload.keychains
              var paymentId = uuid.v4().toLowerCase()
              var wallets = runtime.db.get('wallets', debug)

              host = request.headers.host
              prefix = ((host.indexOf('127.0.0.1') !== 0) && (host.indexOf('localhost') !== 0))
                         ? ('https://' + host) : 'https://ledger-integration.brave.com'
              try {
                result = await runtime.wallet.create(prefix, paymentId, keychains)
                wallet = result.wallet
                wallet.address = wallet.id
              } catch (ex) {
                runtime.notify(debug, { text: 'wallet error: ' + ex.toString() })
                debug('wallet error', ex)
                return reply(boom.badImplementation('wallet creation failed'))
              }

              state = {
                $currentDate: { timestamp: { $type: 'timestamp' } },
                $set: underscore.extend({ keychains: keychains }, underscore.pick(wallet, [ 'address', 'provider' ]))
              }
              await wallets.update({ paymentId: paymentId }, state, { upsert: true })

              await runtime.queue.send(debug, 'persona-report', underscore.extend({ paymentId: paymentId }, state.$set))

              underscore.extend(response, {
                wallet: { paymentId: paymentId, address: wallet.address },
                payload: registrar.payload
              })
            },

      viewing:
            async () => {
            }
    }[registrar.registrarType]
    if ((!!f) && (await f())) return

    state = { $currentDate: { timestamp: { $type: 'timestamp' } } }
    await credentials.update({ uId: uId, registrarId: registrar.registrarId }, state, { upsert: true })

    reply(underscore.extend(response, { verification: verification }))
  }
},

  description: 'Registers a user',
  tags: ['api'],

  validate: {
    params: {
      registrarType: Joi.string().valid('persona', 'viewing').required().description('the type of the registrar'),
      uId: Joi.string().hex().length(31).required().description('the universally-unique identifier')
    },
    payload: Joi.object().keys({
      proof: Joi.string().required().description('credential registration request')
    }).unknown(true).required()
  },

  response: {
    schema: Joi.object().keys({
      verification: Joi.string().required().description('credential registration response'),
      wallet: Joi.object().keys({
        paymentId: Joi.string().guid().required().description('opaque identifier for BTC address'),
        address: braveJoi.string().base58().required().description('BTC address')
      }).optional().description('wallet information'),
      payload: Joi.object().optional().description('additional information'),
      surveyorIds: Joi.array().min(1).items(Joi.string()).optional().description('allowed surveyors'),
      satoshis: Joi.number().integer().min(1).optional().description('contribution amount in satoshis')
    })
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/registrar/{registrarType}').config(v1.read),
  braveHapi.routes.async().patch().path('/v1/registrar/{registrarType}').config(v1.update),
  braveHapi.routes.async().post().path('/v1/registrar/{registrarType}/{uId}').config(v1.create)
]

module.exports.initialize = async (debug, runtime) => {
  var entry, i, payload, registrar, registrarId, registrarType, service, services, state
  var configurations = process.env.REGISTRARS || 'persona:1,viewing:2'
  var registrars = runtime.db.get('registrars', debug)

  runtime.db.checkIndices(debug, [
    {
      category: registrars,
      name: 'registrars',
      property: 'registrarId',
      empty: { registrarId: '', registrarType: '', payload: {}, timestamp: bson.Timestamp.ZERO },
      unique: [ { registrarId: 1 } ],
      others: [ { registrarType: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.db.get('credentials', debug),
      name: 'credentials',
      property: 'registrarId_1_uId',
      empty: { uId: '', registrarId: 0, timestamp: bson.Timestamp.ZERO },
      unique: [ { registrarId: 1, uId: 1 } ],
      others: [ { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('persona-report')

  runtime.registrars = []

  services = configurations.split(',')
  for (i = services.length - 1; i >= 0; i--) {
    service = services[i].split(':')
    registrarType = service[0]
    registrarId = parseInt(service[1], 10)

    entry = await registrars.findOne({ registrarId: registrarId })
    if (entry) {
      if (entry.registrarType !== registrarType) {
        throw new Error('registrar #' + registrarId + ': mismatch, expecting ' + registrarType + ', found ' +
                        entry.registrarType)
      }
      registrar = new anonize.Registrar(entry.parameters)
      payload = entry.payload
    } else {
      registrar = new anonize.Registrar()
      payload = (registrarType === 'persona') ? { adFree: { fee: { USD: 5.00 }, days: 30 } } : {}
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.extend({ registrarType: registrarType, payload: payload }, registrar)
      }
      await registrars.update({ registrarId: registrarId }, state, { upsert: true })
    }

    registrar.registrarId = registrarId
    registrar.registrarType = registrarType
    registrar.payload = payload
    runtime.registrars[registrarType] = registrar
  }
}
