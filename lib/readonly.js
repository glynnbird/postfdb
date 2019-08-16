// middleware which only allows write operations to be
// performed if not in readonly mode
const readonly = (r) => {
  const f = function (req, res, next) {
    if (r) {
      return res.status(403).send({ error: 'Read only operations only' })
    }
    next()
  }
  return f
}

module.exports = readonly
