const defaults = {
  port: 5984,
  readonly: false,
  username: null,
  password: null,
  logging: 'dev'
}

module.exports = {
  port: process.env.PORT || defaults.port,
  readonly: !!(process.env.READONLY || defaults.readonly),
  username: process.env.USERNAME || defaults.username,
  password: process.env.PASSWORD || defaults.password,
  dev: process.env.LOGGING || defaults.logging,
  logging: process.env.LOGGING || defaults.logging
}
