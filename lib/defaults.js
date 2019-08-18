const defaults = {
  port: 5984,
  username: null,
  password: null,
  logging: 'dev'
}

module.exports = {
  port: process.env.PORT || defaults.port,
  username: process.env.USERNAME || defaults.username,
  password: process.env.PASSWORD || defaults.password,
  logging: process.env.LOGGING || defaults.logging
}
