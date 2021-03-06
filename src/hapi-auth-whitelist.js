var boom = require('boom')
var Netmask = require('netmask').Netmask
var underscore = require('underscore')

const whitelist = process.env.IP_WHITELIST && process.env.IP_WHITELIST.split(',')

if (whitelist) {
  var authorizedAddrs = [ '127.0.0.1' ]
  var authorizedBlocks = []

  whitelist.forEach((entry) => {
    if ((entry.indexOf('/') !== -1) || (entry.split('.').length !== 4)) return authorizedBlocks.push(new Netmask(entry))

    authorizedAddrs.push(entry)
  })
}

const internals = {
  implementation: (server, options) => { return { authenticate: exports.authenticate } }
}

exports.authorizedP = (ipaddr) => {
  if ((authorizedAddrs) &&
        ((authorizedAddrs.indexOf(ipaddr) !== -1) ||
         (underscore.find(authorizedBlocks, (block) => { block.contains(ipaddr) })))) return true
}

exports.ipaddr = (request) => {
  return (request.headers['x-forwarded-for'] || request.info.remoteAddress).split(',')[0].trim()
}

exports.authenticate = (request, reply) => {
  var result
  var ipaddr = (request.headers['x-forwarded-for'] || request.info.remoteAddress).split(',')[0].trim()

  if ((authorizedAddrs) &&
        (authorizedAddrs.indexOf(ipaddr) === -1) &&
        (!underscore.find(authorizedBlocks, (block) => { block.contains(ipaddr) }))) return reply(boom.notAcceptable())

  try {
    result = reply.continue({ credentials: { ipaddr: ipaddr } })
  } catch (ex) {
/* something odd with reply.continue not allowing any arguments... */
    result = reply.continue()
  }
  return result
}

exports.register = (server, options, next) => {
  server.auth.scheme('whitelist', internals.implementation)
  server.auth.strategy('whitelist', 'whitelist', {})
  next()
}

exports.register.attributes = {
  pkg: require('../package.json')
}
