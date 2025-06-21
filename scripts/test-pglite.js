const { PGlite } = require('@electric-sql/pglite');

async function test() {
  const db = new PGlite();
  
  try {
    // Test DEFAULT CURRENT_TIMESTAMP
    const result = await db.query(`
      CREATE TABLE test_table (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('SUCCESS: Table created with DEFAULT CURRENT_TIMESTAMP');
  } catch (error) {
    console.log('ERROR with DEFAULT CURRENT_TIMESTAMP:', error.message);
    
    // Try alternative syntax
    try {
      const result2 = await db.query(`
        CREATE TABLE test_table (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      console.log('SUCCESS: Table created with DEFAULT (datetime(\'now\'))');
    } catch (error2) {
      console.log('ERROR with DEFAULT (datetime(\'now\')):', error2.message);
      
      // Try without default
      try {
        const result3 = await db.query(`
          CREATE TABLE test_table (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
          )
        `);
        console.log('SUCCESS: Table created without DEFAULT');
      } catch (error3) {
        console.log('ERROR without DEFAULT:', error3.message);
      }
    }
  }
  
  await db.close();
}

test();
