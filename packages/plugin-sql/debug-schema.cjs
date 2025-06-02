const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { eq } = require('drizzle-orm');
const fs = require('fs');
const path = require('path');

async function testSchemaWithMigration() {
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
    
    // Check tables
    const tables = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables created:', tables.map(t => t.name));
    
    // Now test the schema objects using dynamic import
    console.log('Testing schema objects...');
    
    // Create Drizzle instance
    const db = drizzle(sqliteDb);
    
    try {
      // Test if we can import and use the schema objects
      const { memoryTable, embeddingTable } = await import('./dist/index.js');
      console.log('Schema objects imported successfully');
      
      // Try the same query as the adapter
      console.log('Testing adapter query with schema objects...');
      const result = await db
        .select()
        .from(memoryTable)
        .limit(1);
      
      console.log('Schema query result:', result);
      
    } catch (error) {
      console.error('Schema import/query error:', error);
      
      // Fallback: just test basic schema structure
      console.log('Testing raw table access...');
      const rawResult = sqliteDb.prepare('SELECT COUNT(*) as count FROM memories').get();
      console.log('Raw query still works:', rawResult);
    }
    
  } catch (error) {
    console.error('Error during test:', error);
  } finally {
    sqliteDb.close();
  }
}

testSchemaWithMigration(); 