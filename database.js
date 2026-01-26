const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "energia.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS energia_diaria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pac_id TEXT,
      data TEXT,
      energia_inicio REAL,
      energia_fim REAL,
      consumo REAL,
      UNIQUE (pac_id, data)
    )
  `);
});

module.exports = db;
