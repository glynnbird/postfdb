
const getDocKey = (dbname, id) => {
  return [dbname, 'doc', id]
}

const getChangesKey = (dbname, seq) => {
  return [dbname, 'changes', seq]
}

const getDBKey = (dbname) => {
  return ['_db', dbname]
}

const processDoc = (id, doc) => {
  doc._id = id
  doc._rev = '0-1'
  return doc
}

const getIndexKey = (dbname, indexField, value) => {
  return [dbname, 'index', indexField, value]
}
module.exports = {
  getDocKey,
  getChangesKey,
  getDBKey,
  processDoc,
  getIndexKey
}
