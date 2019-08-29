const encode = (obj) => {
  if (!obj) {
    return null
  }
  const str = JSON.stringify(obj || {})
  return Buffer.from(str).toString('base64').replace(/=/g, '')
}

const decode = (str) => {
  const mod = str.length % 4
  str = str + '='.repeat(mod)
  str = Buffer.from(str || '', 'base64').toString()
  try {
    return JSON.parse(str)
  } catch (e) {
    return null
  }
}

module.exports = {
  encode,
  decode
}
