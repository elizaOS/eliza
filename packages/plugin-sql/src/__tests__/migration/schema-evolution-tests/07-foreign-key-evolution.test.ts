import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { pgTable, text, uuid, foreignKey, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { RuntimeMigrator } from '../../../runtime-migrator/runtime-migrator';
import type { DrizzleDB } from '../../../runtime-migrator/types';
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from '../../test-helpers';

/**
 * Schema Evolution Test 11 & 12: Foreign Key Evolution
 *
 * Tests adding foreign keys to existing data and modifying CASCADE behavior.
 * These operations can fail if there are orphaned records.
 */

describe('Schema Evolution Test: Foreign Key Evolution', () => {
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testSetup = await createIsolatedTestDatabaseForSchemaEvolutionTests(
      'schema_evolution_foreign_key_evolution_test'
    );
    db = testSetup.db;
    cleanup = testSetup.cleanup;

    migrator = new RuntimeMigrator(db);
    await migrator.initialize();

    // Enable for tests that need it
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it('should handle adding foreign keys with orphaned records', async () => {
    // V1: Tables without foreign key constraints
    const agentTableV1 = pgTable('agents', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const memoryTableV1 = pgTable('memories', {
      id: uuid('id').primaryKey().defaultRandom(),
      agentId: uuid('agent_id'), // No FK constraint
      content: text('content').notNull(),
    });

    const schemaV1 = {
      agents: agentTableV1,
      memories: memoryTableV1,
    };

    console.log('📦 Creating tables without foreign keys...');
    await migrator.migrate('@elizaos/fk-test-v1', schemaV1);

    // Create valid agents
    const agent1Id = '550e8400-e29b-41d4-a716-446655440001';
    const agent2Id = '550e8400-e29b-41d4-a716-446655440002';

    await db.insert(agentTableV1).values([
      { id: agent1Id, name: 'Agent 1' },
      { id: agent2Id, name: 'Agent 2' },
    ]);

    // Create memories - some with valid agent IDs, some orphaned
    await db.insert(memoryTableV1).values([
      { agentId: agent1Id, content: 'Memory 1 - Valid' },
      { agentId: agent2Id, content: 'Memory 2 - Valid' },
      { agentId: '999e8400-e29b-41d4-a716-446655440999', content: 'Memory 3 - Orphaned!' },
      { agentId: null, content: 'Memory 4 - Null agent' },
      { agentId: '888e8400-e29b-41d4-a716-446655440888', content: 'Memory 5 - Orphaned!' },
    ]);

    console.log('  ✅ Created 2 agents and 5 memories (2 orphaned)');

    // V2: Add foreign key constraint
    const agentTableV2 = pgTable('agents', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const memoryTableV2 = pgTable('memories', {
      id: uuid('id').primaryKey().defaultRandom(),
      agentId: uuid('agent_id').references(() => agentTableV2.id, {
        onDelete: 'cascade',
      }),
      content: text('content').notNull(),
    });

    const schemaV2 = {
      agents: agentTableV2,
      memories: memoryTableV2,
    };

    console.log('\n🔍 Checking foreign key addition...');
    const check = await migrator.checkMigration('@elizaos/fk-test-v1', schemaV2);

    if (check) {
      console.log('  ⚠️ Foreign key analysis:');
      if (check.warnings.length > 0) {
        check.warnings.forEach((w) => console.log(`    - ${w}`));
      }
    }

    // Try to apply - should fail due to orphaned records
    console.log('\n❌ Attempting to add FK with orphaned records...');
    let migrationError: Error | null = null;
    try {
      await migrator.migrate('@elizaos/fk-test-v1', schemaV2);
    } catch (error) {
      migrationError = error as Error;
    }

    if (migrationError) {
      console.log('  ✅ Migration failed as expected (orphaned records)');
      console.log(`  Error: ${migrationError.message.substring(0, 100)}...`);
    }

    // Find and fix orphaned records
    console.log('\n🔧 Finding orphaned records...');
    const orphaned = await db.execute(
      sql`SELECT m.* FROM memories m 
          LEFT JOIN agents a ON m.agent_id = a.id 
          WHERE m.agent_id IS NOT NULL AND a.id IS NULL`
    );
    console.log(`  Found ${orphaned.rows.length} orphaned memories`);

    // Clean up orphaned records
    await db.execute(
      sql`DELETE FROM memories 
          WHERE agent_id NOT IN (SELECT id FROM agents) 
          AND agent_id IS NOT NULL`
    );
    console.log('  ✅ Deleted orphaned records');

    // Now migration should succeed
    console.log('\n📦 Retrying FK addition after cleanup...');
    await migrator.migrate('@elizaos/fk-test-v1', schemaV2);
    console.log('  ✅ Foreign key constraint added successfully');

    // Verify FK is enforced
    let insertError: Error | null = null;
    try {
      await db.execute(
        sql`INSERT INTO memories (agent_id, content) 
            VALUES ('999e8400-e29b-41d4-a716-446655440999', 'Should fail')`
      );
    } catch (error) {
      insertError = error as Error;
    }

    expect(insertError).not.toBeNull();
    console.log('  ✅ Foreign key constraint is now enforced');
  });

  it('should handle changing CASCADE behavior', async () => {
    // V1: Tables with CASCADE delete
    const parentTableV1 = pgTable('parents', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const childTableV1 = pgTable('children', {
      id: uuid('id').primaryKey().defaultRandom(),
      parentId: uuid('parent_id')
        .notNull()
        .references(() => parentTableV1.id, {
          onDelete: 'cascade', // CASCADE delete
        }),
      name: text('name').notNull(),
    });

    const schemaV1 = {
      parents: parentTableV1,
      children: childTableV1,
    };

    console.log('📦 Creating tables with CASCADE delete...');
    await migrator.migrate('@elizaos/cascade-test-v1', schemaV1);

    // Create test data
    const parent1Id = '110e8400-e29b-41d4-a716-446655440001';
    const parent2Id = '110e8400-e29b-41d4-a716-446655440002';

    await db.insert(parentTableV1).values([
      { id: parent1Id, name: 'Parent 1' },
      { id: parent2Id, name: 'Parent 2' },
    ]);

    await db.insert(childTableV1).values([
      { parentId: parent1Id, name: 'Child 1-1' },
      { parentId: parent1Id, name: 'Child 1-2' },
      { parentId: parent2Id, name: 'Child 2-1' },
    ]);

    console.log('  ✅ Created 2 parents with 3 children');

    // Test CASCADE delete behavior
    console.log('\n🔍 Testing current CASCADE behavior...');
    await db.execute(sql`DELETE FROM parents WHERE id = ${parent1Id}`);
    const remainingChildren = await db.execute(
      sql`SELECT COUNT(*) as count FROM children WHERE parent_id = ${parent1Id}`
    );
    expect((remainingChildren.rows[0] as any).count).toBe(0);
    console.log('  ✅ CASCADE delete removed children as expected');

    // Restore data
    await db.insert(parentTableV1).values({ id: parent1Id, name: 'Parent 1' });
    await db.insert(childTableV1).values([
      { parentId: parent1Id, name: 'Child 1-1' },
      { parentId: parent1Id, name: 'Child 1-2' },
    ]);

    // V2: Change to SET NULL
    const parentTableV2 = pgTable('parents', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const childTableV2 = pgTable('children', {
      id: uuid('id').primaryKey().defaultRandom(),
      parentId: uuid('parent_id').references(() => parentTableV2.id, {
        onDelete: 'set null', // Changed to SET NULL
      }),
      name: text('name').notNull(),
    });

    const schemaV2 = {
      parents: parentTableV2,
      children: childTableV2,
    };

    console.log('\n📦 Changing CASCADE behavior to SET NULL...');
    const check = await migrator.checkMigration('@elizaos/cascade-test-v1', schemaV2);

    if (check) {
      console.log('  ℹ️ Cascade behavior change detected');
      if (check.warnings.length > 0) {
        check.warnings.forEach((w) => console.log(`    - ${w}`));
      }
    }

    await migrator.migrate('@elizaos/cascade-test-v1', schemaV2);
    console.log('  ✅ CASCADE behavior changed to SET NULL');

    // Test new SET NULL behavior
    console.log('\n🔍 Testing new SET NULL behavior...');
    await db.execute(sql`DELETE FROM parents WHERE id = ${parent2Id}`);
    const orphanedChildren = await db.execute(sql`SELECT * FROM children WHERE parent_id IS NULL`);
    expect(orphanedChildren.rows.length).toBe(1); // Child 2-1 should have NULL parent_id
    console.log('  ✅ SET NULL behavior working (children not deleted)');
    console.log(`     Orphaned child: ${(orphanedChildren.rows[0] as any).name}`);
  });

  it('should handle complex foreign key scenarios with composite keys', async () => {
    // V1: Complex relationship structure without FKs
    const worldTableV1 = pgTable('worlds', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const agentTableV1 = pgTable('agents', {
      id: uuid('id').primaryKey().defaultRandom(),
      worldId: uuid('world_id'), // No FK
      name: text('name').notNull(),
    });

    const roomTableV1 = pgTable('rooms', {
      id: uuid('id').primaryKey().defaultRandom(),
      worldId: uuid('world_id'), // No FK
      agentId: uuid('agent_id'), // No FK
      name: text('name').notNull(),
    });

    const memoryTableV1 = pgTable('memories', {
      id: uuid('id').primaryKey().defaultRandom(),
      roomId: uuid('room_id'), // No FK
      agentId: uuid('agent_id'), // No FK
      content: text('content').notNull(),
    });

    const schemaV1 = {
      worlds: worldTableV1,
      agents: agentTableV1,
      rooms: roomTableV1,
      memories: memoryTableV1,
    };

    console.log('📦 Creating complex structure without FKs...');
    await migrator.migrate('@elizaos/complex-fk-v1', schemaV1);

    // Create interconnected data
    const worldId = '220e8400-e29b-41d4-a716-446655440001';
    const agentId = '330e8400-e29b-41d4-a716-446655440001';
    const roomId = '440e8400-e29b-41d4-a716-446655440001';

    await db.insert(worldTableV1).values({ id: worldId, name: 'World 1' });
    await db.insert(agentTableV1).values({ id: agentId, worldId, name: 'Agent 1' });
    await db.insert(roomTableV1).values({ id: roomId, worldId, agentId, name: 'Room 1' });
    await db.insert(memoryTableV1).values({ roomId, agentId, content: 'Memory 1' });

    console.log('  ✅ Created interconnected data');

    // V2: Add all foreign keys with different CASCADE behaviors
    const worldTableV2 = pgTable('worlds', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    });

    const agentTableV2 = pgTable(
      'agents',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        worldId: uuid('world_id').references(() => worldTableV2.id, {
          onDelete: 'cascade', // Delete agents when world deleted
        }),
        name: text('name').notNull(),
      },
      (table) => ({
        // Add unique constraint needed for composite FK from rooms table
        worldAgentUnique: unique().on(table.worldId, table.id),
      })
    );

    const roomTableV2 = pgTable(
      'rooms',
      {
        id: uuid('id').primaryKey().defaultRandom(),
        worldId: uuid('world_id').references(() => worldTableV2.id, {
          onDelete: 'cascade', // Delete rooms when world deleted
        }),
        agentId: uuid('agent_id').references(() => agentTableV2.id, {
          onDelete: 'set null', // Keep rooms but clear agent reference
        }),
        name: text('name').notNull(),
      },
      (table) => [
        // Composite foreign key example - requires unique constraint on referenced columns
        // The agents table has a unique constraint on (worldId, id) to make this valid
        foreignKey({
          columns: [table.worldId, table.agentId],
          foreignColumns: [agentTableV2.worldId, agentTableV2.id],
        }),
      ]
    );

    const memoryTableV2 = pgTable('memories', {
      id: uuid('id').primaryKey().defaultRandom(),
      roomId: uuid('room_id').references(() => roomTableV2.id, {
        onDelete: 'cascade', // Delete memories when room deleted
      }),
      agentId: uuid('agent_id').references(() => agentTableV2.id, {
        onDelete: 'cascade', // Delete memories when agent deleted
      }),
      content: text('content').notNull(),
    });

    const schemaV2 = {
      worlds: worldTableV2,
      agents: agentTableV2,
      rooms: roomTableV2,
      memories: memoryTableV2,
    };

    console.log('\n📦 Adding complex FK relationships...');
    await migrator.migrate('@elizaos/complex-fk-v1', schemaV2);
    console.log('  ✅ Complex foreign keys added');

    // Test CASCADE behaviors
    console.log('\n🔍 Testing complex CASCADE behaviors...');

    // Delete world should cascade to everything
    await db.execute(sql`DELETE FROM worlds WHERE id = ${worldId}`);

    const counts = await db.execute(sql`
      SELECT 
        (SELECT COUNT(*) FROM agents WHERE world_id = ${worldId}) as agents,
        (SELECT COUNT(*) FROM rooms WHERE world_id = ${worldId}) as rooms,
        (SELECT COUNT(*) FROM memories WHERE agent_id = ${agentId}) as memories
    `);

    const result = counts.rows[0] as any;
    expect(result.agents).toBe(0);
    expect(result.rooms).toBe(0);
    expect(result.memories).toBe(0);

    console.log('  ✅ CASCADE delete propagated correctly through all relationships');
  });

  it('should handle foreign keys with manager references', async () => {
    // V1: Tables with manager-employee relationship
    const departmentTableV1 = pgTable('departments', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      managerId: uuid('manager_id'), // Will reference employees
    });

    const employeeTableV1 = pgTable('employees', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      departmentId: uuid('department_id'), // Will reference departments
    });

    const schemaV1 = {
      departments: departmentTableV1,
      employees: employeeTableV1,
    };

    console.log('📦 Creating tables for manager reference test...');
    await migrator.migrate('@elizaos/circular-fk-v1', schemaV1);

    // Create data
    const dept1Id = '550e8400-e29b-41d4-a716-446655440001';
    const emp1Id = '660e8400-e29b-41d4-a716-446655440001';
    const emp2Id = '660e8400-e29b-41d4-a716-446655440002';

    await db.insert(departmentTableV1).values({
      id: dept1Id,
      name: 'Engineering',
      managerId: emp1Id, // Points to employee (no constraint yet)
    });

    await db.insert(employeeTableV1).values([
      { id: emp1Id, name: 'Alice (Manager)', departmentId: dept1Id },
      { id: emp2Id, name: 'Bob', departmentId: dept1Id },
    ]);

    console.log('  ✅ Created department with manager reference');

    // V2: Add foreign keys (one direction only for this test)
    // Note: True circular FKs require special handling in Drizzle
    const employeeTableV2 = pgTable('employees', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      departmentId: uuid('department_id'),
    });

    const departmentTableV2 = pgTable('departments', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      managerId: uuid('manager_id').references(() => employeeTableV2.id, {
        onDelete: 'set null', // Manager leaves, department remains
      }),
    });

    const schemaV2 = {
      departments: departmentTableV2,
      employees: employeeTableV2,
    };

    console.log('\n📦 Adding foreign key from departments to employees...');
    await migrator.migrate('@elizaos/circular-fk-v1', schemaV2);
    console.log('  ✅ Manager reference foreign key created successfully');

    // Test that constraints work
    console.log('\n🔍 Testing manager reference constraints...');

    // Try to insert invalid manager
    let insertError: Error | null = null;
    try {
      await db.execute(
        sql`INSERT INTO departments (name, manager_id) 
            VALUES ('Invalid Dept', '999e8400-e29b-41d4-a716-446655440999')`
      );
    } catch (error) {
      insertError = error as Error;
    }

    expect(insertError).not.toBeNull();
    console.log('  ✅ Invalid manager reference blocked');

    // Delete employee who is a manager
    await db.execute(sql`DELETE FROM employees WHERE id = ${emp1Id}`);
    const deptAfter = await db.execute(
      sql`SELECT manager_id FROM departments WHERE id = ${dept1Id}`
    );
    expect((deptAfter.rows[0] as any).manager_id).toBeNull();
    console.log('  ✅ Manager deletion sets department.manager_id to NULL');
  });
});
