#!/usr/bin/env node

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

console.log('🔧 DEBUG: Creating PGLite instance...');

const pglite = new PGlite({
  dataDir: ':memory:',
  extensions: {
    vector,
    fuzzystrmatch,
  },
  relaxedDurability: true,
});

console.log('🔧 DEBUG: PGLite instance created successfully');

const db = drizzle(pglite);

console.log('🔧 DEBUG: Drizzle instance created successfully');

try {
  console.log('🔧 DEBUG: About to test SELECT 1...');
  const result = await db.execute(sql.raw('SELECT 1 as test'));
  console.log('🔧 DEBUG: SELECT 1 success, result:', result);
} catch (error) {
  console.error('🔧 DEBUG: SELECT 1 failed');
  console.error('🔧 DEBUG: Error message:', error.message);
  console.error('🔧 DEBUG: Error type:', typeof error);
  console.error('🔧 DEBUG: Error constructor:', error.constructor.name);
  console.error('🔧 DEBUG: Full error:', error);
}

try {
  console.log('🔧 DEBUG: About to test CREATE TABLE...');
  const result = await db.execute(sql.raw('CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY)'));
  console.log('🔧 DEBUG: CREATE TABLE success, result:', result);
} catch (error) {
  console.error('🔧 DEBUG: CREATE TABLE failed');
  console.error('🔧 DEBUG: Error message:', error.message);
  console.error('🔧 DEBUG: Error type:', typeof error);
  console.error('🔧 DEBUG: Error constructor:', error.constructor.name);
  console.error('🔧 DEBUG: Full error:', error);
}

console.log('🔧 DEBUG: Test complete');