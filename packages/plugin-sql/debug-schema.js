#!/usr/bin/env node

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

console.log('🔧 DEBUG SCHEMA: Creating PGLite instance...');

const pglite = new PGlite({
  dataDir: ':memory:',
  extensions: {
    vector,
    fuzzystrmatch,
  },
  relaxedDurability: true,
});

const db = drizzle(pglite);

// Create the tables with our current simple migrator schema
console.log('🔧 Creating entities table...');
await db.execute(sql.raw(`
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    names TEXT NOT NULL DEFAULT '[]',
    agent_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT DEFAULT '{}'
  )
`));

console.log('🔧 Creating components table with case-sensitive names...');
await db.execute(sql.raw(`
  CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    entityid TEXT NOT NULL,
    agentid TEXT NOT NULL,
    roomid TEXT NOT NULL,
    worldid TEXT,
    sourceentityid TEXT,
    type TEXT NOT NULL,
    data TEXT DEFAULT '{}',
    createdat TEXT DEFAULT CURRENT_TIMESTAMP
  )
`));

// First, let's check what columns actually exist
console.log('🔧 Checking components table columns...');
try {
  const columnsResult = await db.execute(sql.raw(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'components' 
    ORDER BY ordinal_position
  `));
  console.log('🔧 Components columns:', columnsResult.rows);
} catch (error) {
  console.error('🔧 Failed to check columns:', error.message);
}

// Test basic select from each table first
console.log('🔧 Testing basic SELECT from entities...');
try {
  const result = await db.execute(sql.raw(`SELECT id FROM entities LIMIT 1`));
  console.log('🔧 Entities table works, result:', result.rows);
} catch (error) {
  console.error('🔧 Basic entities select failed:', error.message);
}

console.log('🔧 Testing basic SELECT from components...');
try {
  const result = await db.execute(sql.raw(`SELECT id FROM components LIMIT 1`));
  console.log('🔧 Components table works, result:', result.rows);
} catch (error) {
  console.error('🔧 Basic components select failed:', error.message);
}

// Test simple join without parameters
console.log('🔧 Testing simple join without parameters...');
try {
  const result = await db.execute(sql.raw(`
    SELECT e.id, c.entityid 
    FROM entities e 
    LEFT JOIN components c ON c.entityid = e.id 
    LIMIT 1
  `));
  console.log('🔧 Simple join works! Result:', result.rows);
} catch (error) {
  console.error('🔧 Simple join failed:', error.message);
}

// Test parameterized query issue with Drizzle properly
console.log('🔧 Testing parameterized query with Drizzle placeholders...');
try {
  const testId = '00000000-0000-0000-0000-000000000000';
  const result = await db.execute(sql.raw(`
    SELECT 
      entities.id
    FROM entities 
    WHERE entities.id = ${sql.placeholder('id')}
  `, { id: testId }));
  
  console.log('🔧 SUCCESS: Drizzle parameterized query worked! Result:', result.rows);
} catch (error) {
  console.error('🔧 FAILED: Drizzle parameterized query failed');
  console.error('🔧 Error message:', error.message);
}

// Test direct PGLite query (not through Drizzle)
console.log('🔧 Testing direct PGLite parameterized query...');
try {
  const testId = '00000000-0000-0000-0000-000000000000';
  const connection = db.config.client; // Get the raw PGLite connection
  const result = await connection.query(`
    SELECT 
      entities.id
    FROM entities 
    WHERE entities.id = $1
  `, [testId]);
  
  console.log('🔧 SUCCESS: Direct PGLite query worked! Result:', result.rows);
} catch (error) {
  console.error('🔧 FAILED: Direct PGLite query failed');
  console.error('🔧 Error message:', error.message);
}

// Test parameterized query with IN clause
console.log('🔧 Testing parameterized IN query...');
try {
  const result = await db.execute(sql.raw(`
    SELECT entities.id
    FROM entities 
    WHERE entities.id IN ($1)
  `, ['00000000-0000-0000-0000-000000000000']));
  
  console.log('🔧 SUCCESS: Parameterized IN query worked! Result:', result.rows);
} catch (error) {
  console.error('🔧 FAILED: Parameterized IN query failed');
  console.error('🔧 Error message:', error.message);
}

// Now test the exact query that's failing
console.log('🔧 Testing the original problematic join query...');
try {
  const result = await db.execute(sql.raw(`
    select 
      "entities"."id", 
      "entities"."agent_id", 
      "entities"."created_at", 
      "entities"."names", 
      "entities"."metadata", 
      "components"."id", 
      "components"."entityId", 
      "components"."agentId", 
      "components"."roomId", 
      "components"."worldId", 
      "components"."sourceEntityId", 
      "components"."type", 
      "components"."data", 
      "components"."createdAt" 
    from "entities" 
    left join "components" on "components"."entityId" = "entities"."id" 
    where "entities"."id" in ($1)
  `, ['00000000-0000-0000-0000-000000000000']));
  
  console.log('🔧 SUCCESS: Original query worked! Result:', result);
} catch (error) {
  console.error('🔧 FAILED: Original query failed');
  console.error('🔧 Error message:', error.message);
}

console.log('🔧 DEBUG SCHEMA: Test complete');