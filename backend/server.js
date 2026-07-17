'use strict';

// Requiring db.js here triggers its top-level CREATE TABLE IF NOT EXISTS
// statements, ensuring the schema is fully initialised before the server
// accepts any requests — even on a fresh database file.
require('./src/db');

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Payout Management System backend running on http://localhost:${PORT}`);
});
