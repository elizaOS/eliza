const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

async function testMigration() {
  console.log('Creating in-memory database...');
  const db = new Database(':memory:');
  
  try {
    // Set up the database like the manager does
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    
    console.log('Reading migration file...');
    const migrationPath = path.resolve('./drizzle/sqlite-migrations/0000_snapshot.sql');
    const sqlScript = fs.readFileSync(migrationPath, 'utf-8');
    
    console.log('Migration file length:', sqlScript.length);
    console.log('First 200 chars:', sqlScript.substring(0, 200));
    
    // Split and execute like the manager does
    const statements = sqlScript
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);
    
    console.log('Number of statements:', statements.length);
    
    const transaction = db.transaction(() => {
      for (const statement of statements) {
        console.log('Executing:', statement.substring(0, 50) + '...');
        try {
          db.prepare(statement).run();
        } catch (error) {
          console.error('Error in statement:', statement);
          throw error;
        }
      }
    });
    
    console.log('Running transaction...');
    transaction();
    
    // Check what tables exist - fixed quotes
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables created:', tables.map(t => t.name));
    
    // Try the same query that's failing in the adapter
    console.log('Testing memories table query...');
    const testQuery = db.prepare('SELECT COUNT(*) as count FROM memories');
    const result = testQuery.get();
    console.log('Memories table query result:', result);
    
    // Test the specific query from the adapter
    console.log('Testing adapter-style query...');
    const adapterQuery = db.prepare(`
      SELECT e.dim_384 as embedding
      FROM memories m
      INNER JOIN embeddings e ON m.id = e.memory_id
      WHERE m.agentId = ?
      LIMIT 1
    `);
    const adapterResult = adapterQuery.all('test-agent-id');
    console.log('Adapter-style query result:', adapterResult);
    
  } catch (error) {
    console.error('Error during migration test:', error);
  } finally {
    db.close();
  }
}

testMigration(); 