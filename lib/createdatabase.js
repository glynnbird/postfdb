const keyutils = require('./keyutils.js')

module.exports = async (db, databaseName) => {
  const k = keyutils.getDBKey(databaseName)
  const existingDB = await db.get(k)
  if (existingDB) {
    throw new Error('existing database')
  }
  const obj = {
    update_seq: '0',
    db_name: databaseName,
    purge_seq: 0,
    doc_del_count: 0,
    doc_count: 0
  }
  await db.set(k, obj)
}
