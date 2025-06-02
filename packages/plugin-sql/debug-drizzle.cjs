const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { eq } = require('drizzle-orm');
const fs = require('fs');
const path = require('path');

async function testDrizzleWithMigration() {
  console.log('Creating in-memory database...');
  const sqliteDb = new Database(':memory:');
  
  try {
    // Set up the database like the manager does
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    sqliteDb.pragma('synchronous = NORMAL');
    
    console.log('Running migration...');
    const migrationPath = path.resolve('./drizzle/sqlite-migrations/0000_snapshot.sql');
    const sqlScript = fs.readFileSync(migrationPath, 'utf-8');
    
    // Execute migration
    const statements = sqlScript
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);
    
    const transaction = sqliteDb.transaction(() => {
      for (const statement of statements) {
        try {
          sqliteDb.prepare(statement).run();
        } catch (error) {
          console.error('Migration error:', error);
          throw error;
        }
      }
    });
    
    transaction();
    console.log('Migration completed');
    
    // Check tables with raw SQL
    const tables = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables from raw SQL:', tables.map(t => t.name));
    
    // Now try with Drizzle
    console.log('Creating Drizzle instance...');
    const db = drizzle(sqliteDb);
    
    // Try to run a simple query like the adapter does
    console.log('Testing Drizzle query...');
    try {
      // This is similar to what the adapter does in init()
      const result = await db.execute(sqliteDb.prepare('SELECT COUNT(*) as count FROM memories'));
      console.log('Drizzle query result:', result);
    } catch (error) {
      console.error('Drizzle query error:', error);
    }
    
    // Try raw SQL through Drizzle
    console.log('Testing raw SQL through Drizzle...');
    try {
      const rawResult = sqliteDb.prepare('SELECT COUNT(*) as count FROM memories').get();
      console.log('Raw SQL result:', rawResult);
    } catch (error) {
      console.error('Raw SQL error:', error);
    }
    
  } catch (error) {
    console.error('Error during test:', error);
  } finally {
    sqliteDb.close();
  }
}

testDrizzleWithMigration(); 