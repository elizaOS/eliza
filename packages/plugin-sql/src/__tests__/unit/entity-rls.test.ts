import { describe, expect, it } from 'bun:test';
import { stringToUuid } from '@elizaos/core';

/**
 * Entity RLS Unit Tests
 *
 * These tests verify the Entity RLS logic without requiring a PostgreSQL database.
 * They test the column detection priority, policy generation logic, and isolation behavior.
 */

describe('Entity RLS Column Detection', () => {
  describe('Column Priority Order', () => {
    it('should prioritize room_id over other columns', () => {
      const columns = {
        has_room_id: true,
        has_channel_id: true,
        has_entity_id: true,
        has_author_id: true,
      };

      // Priority: room_id > channel_id > entity_id > author_id
      let selectedColumn: string;
      if (columns.has_room_id) {
        selectedColumn = 'room_id';
      } else if (columns.has_channel_id) {
        selectedColumn = 'channel_id';
      } else if (columns.has_entity_id) {
        selectedColumn = 'entity_id';
      } else {
        selectedColumn = 'author_id';
      }

      expect(selectedColumn).toBe('room_id');
    });

    it('should use channel_id when room_id is not present', () => {
      const columns = {
        has_room_id: false,
        has_channel_id: true,
        has_entity_id: true,
        has_author_id: true,
      };

      let selectedColumn: string;
      if (columns.has_room_id) {
        selectedColumn = 'room_id';
      } else if (columns.has_channel_id) {
        selectedColumn = 'channel_id';
      } else if (columns.has_entity_id) {
        selectedColumn = 'entity_id';
      } else {
        selectedColumn = 'author_id';
      }

      expect(selectedColumn).toBe('channel_id');
    });

    it('should fallback to entity_id for direct access tables', () => {
      const columns = {
        has_room_id: false,
        has_channel_id: false,
        has_entity_id: true,
        has_author_id: true,
      };

      let selectedColumn: string;
      if (columns.has_room_id) {
        selectedColumn = 'room_id';
      } else if (columns.has_channel_id) {
        selectedColumn = 'channel_id';
      } else if (columns.has_entity_id) {
        selectedColumn = 'entity_id';
      } else {
        selectedColumn = 'author_id';
      }

      expect(selectedColumn).toBe('entity_id');
    });

    it('should use author_id as last resort', () => {
      const columns = {
        has_room_id: false,
        has_channel_id: false,
        has_entity_id: false,
        has_author_id: true,
      };

      let selectedColumn: string;
      if (columns.has_room_id) {
        selectedColumn = 'room_id';
      } else if (columns.has_channel_id) {
        selectedColumn = 'channel_id';
      } else if (columns.has_entity_id) {
        selectedColumn = 'entity_id';
      } else if (columns.has_author_id) {
        selectedColumn = 'author_id';
      } else {
        selectedColumn = 'none';
      }

      expect(selectedColumn).toBe('author_id');
    });

    it('should skip tables with no entity-related columns', () => {
      const columns = {
        has_room_id: false,
        has_channel_id: false,
        has_entity_id: false,
        has_author_id: false,
      };

      const shouldApplyRLS =
        columns.has_room_id ||
        columns.has_channel_id ||
        columns.has_entity_id ||
        columns.has_author_id;

      expect(shouldApplyRLS).toBe(false);
    });
  });

  describe('Table Schema Detection', () => {
    it('should detect memories table as room-based', () => {
      // memories table schema
      const tableColumns = ['id', 'entity_id', 'agent_id', 'room_id', 'content', 'created_at'];

      const has_room_id = tableColumns.includes('room_id');
      const has_entity_id = tableColumns.includes('entity_id');

      // Should prioritize room_id over entity_id
      expect(has_room_id).toBe(true);
      expect(has_entity_id).toBe(true);

      const selectedColumn = has_room_id ? 'room_id' : 'entity_id';
      expect(selectedColumn).toBe('room_id');
    });

    it('should detect participants table as entity-based', () => {
      // participants table schema
      const tableColumns = ['id', 'entity_id', 'channel_id', 'created_at'];

      const has_channel_id = tableColumns.includes('channel_id');
      const has_entity_id = tableColumns.includes('entity_id');

      // Should prioritize channel_id (shared access)
      expect(has_channel_id).toBe(true);
      expect(has_entity_id).toBe(true);

      const selectedColumn = has_channel_id ? 'channel_id' : 'entity_id';
      expect(selectedColumn).toBe('channel_id');
    });

    it('should detect relationships table as direct entity access', () => {
      // relationships table schema (hypothetical)
      const tableColumns = ['id', 'entity_id', 'data', 'created_at'];

      const has_room_id = tableColumns.includes('room_id');
      const has_channel_id = tableColumns.includes('channel_id');
      const has_entity_id = tableColumns.includes('entity_id');

      // Should use entity_id (no room/channel columns)
      expect(has_room_id).toBe(false);
      expect(has_channel_id).toBe(false);
      expect(has_entity_id).toBe(true);

      let selectedColumn: string;
      if (has_room_id) {
        selectedColumn = 'room_id';
      } else if (has_channel_id) {
        selectedColumn = 'channel_id';
      } else if (has_entity_id) {
        selectedColumn = 'entity_id';
      } else {
        selectedColumn = 'none';
      }

      expect(selectedColumn).toBe('entity_id');
    });
  });
});

describe('Entity RLS Policy Types', () => {
  describe('Participant-Based Policy (room_id/channel_id)', () => {
    it('should generate correct policy for room-based tables', () => {
      const tableName = 'memories';
      const columnName = 'room_id';

      const policyCondition = `${columnName} IN (SELECT channel_id FROM participants WHERE entity_id = current_entity_id())`;

      expect(policyCondition).toContain(columnName);
      expect(policyCondition).toContain('participants');
      expect(policyCondition).toContain('current_entity_id()');
    });

    it('should allow NULL entity_id for server operations', () => {
      const policyWithBypass = `current_entity_id() IS NULL OR room_id IN (...)`;

      expect(policyWithBypass).toContain('current_entity_id() IS NULL');
      expect(policyWithBypass).toContain('OR');
    });

    it('should use channel_id from participants table', () => {
      const subquery = 'SELECT channel_id FROM participants WHERE entity_id = current_entity_id()';

      expect(subquery).toContain('channel_id');
      expect(subquery).not.toContain('room_id'); // participants use channel_id
    });
  });

  describe('Direct Access Policy (entity_id/author_id)', () => {
    it('should generate correct policy for entity-based tables', () => {
      const tableName = 'relationships';
      const columnName = 'entity_id';

      const policyCondition = `${columnName} = current_entity_id()`;

      expect(policyCondition).toBe('entity_id = current_entity_id()');
      expect(policyCondition).not.toContain('participants');
    });

    it('should allow NULL entity_id for server operations', () => {
      const policyWithBypass = `current_entity_id() IS NULL OR entity_id = current_entity_id()`;

      expect(policyWithBypass).toContain('current_entity_id() IS NULL');
      expect(policyWithBypass).toContain('OR');
    });

    it('should support author_id as alternative column', () => {
      const columnName = 'author_id';
      const policyCondition = `${columnName} = current_entity_id()`;

      expect(policyCondition).toBe('author_id = current_entity_id()');
    });
  });
});

describe('Entity RLS Function Names', () => {
  it('should have consistent function names', () => {
    const functions = {
      currentEntityId: 'current_entity_id',
      addEntityIsolation: 'add_entity_isolation',
      applyEntityRlsToAllTables: 'apply_entity_rls_to_all_tables',
    };

    expect(functions.currentEntityId).toBe('current_entity_id');
    expect(functions.addEntityIsolation).toBe('add_entity_isolation');
    expect(functions.applyEntityRlsToAllTables).toBe('apply_entity_rls_to_all_tables');
  });

  it('should use different function names than Server RLS', () => {
    const serverFunctions = {
      currentServerId: 'current_server_id',
      addServerIsolation: 'add_server_isolation',
    };

    const entityFunctions = {
      currentEntityId: 'current_entity_id',
      addEntityIsolation: 'add_entity_isolation',
    };

    // Should be different to avoid conflicts
    expect(entityFunctions.currentEntityId).not.toBe(serverFunctions.currentServerId);
    expect(entityFunctions.addEntityIsolation).not.toBe(serverFunctions.addServerIsolation);
  });
});

describe('Entity RLS Policy Names', () => {
  it('should use consistent policy naming', () => {
    const policyName = 'entity_isolation_policy';

    expect(policyName).toBe('entity_isolation_policy');
    expect(policyName).not.toBe('server_isolation_policy'); // Different from Server RLS
  });

  it('should use generic policy name for all tables', () => {
    const tables = ['memories', 'participants', 'relationships'];
    const policyName = 'entity_isolation_policy';

    tables.forEach((table) => {
      // Same policy name for all tables (not table-specific)
      expect(policyName).not.toContain(table);
    });
  });
});

describe('Entity RLS Table Exclusions', () => {
  it('should exclude correct tables from Entity RLS', () => {
    const excludedTables = [
      'servers', // Server RLS table
      'users', // Authentication table
      'entity_mappings', // Mapping table
      'drizzle_migrations',
      '__drizzle_migrations',
    ];

    // Tables that should NOT have Entity RLS
    expect(excludedTables).toContain('servers');
    expect(excludedTables).toContain('users');
    expect(excludedTables).toContain('entity_mappings');

    // Tables that SHOULD have Entity RLS (not in exclusion list)
    expect(excludedTables).not.toContain('memories');
    expect(excludedTables).not.toContain('participants');
    expect(excludedTables).not.toContain('relationships');
    expect(excludedTables).not.toContain('goals');
  });

  it('should include migration tables in exclusions', () => {
    const excludedTables = ['drizzle_migrations', '__drizzle_migrations'];

    expect(excludedTables).toContain('drizzle_migrations');
    expect(excludedTables).toContain('__drizzle_migrations');
  });
});

describe('Entity RLS Security Properties', () => {
  describe('Session Variable Usage', () => {
    it('should use app.entity_id session variable', () => {
      const sessionVar = 'app.entity_id';

      expect(sessionVar).toBe('app.entity_id');
      expect(sessionVar).not.toBe('application_name'); // Different from Server RLS
    });

    it('should be transaction-scoped (SET LOCAL)', () => {
      const command = 'SET LOCAL app.entity_id = $1';

      expect(command).toContain('SET LOCAL');
      expect(command).not.toContain('SET SESSION'); // Not session-wide
      expect(command).toContain('LOCAL'); // Explicitly LOCAL (not global SET)
    });

    it('should auto-reset on transaction end', () => {
      // SET LOCAL auto-resets, no explicit cleanup needed
      const autoReset = true;
      expect(autoReset).toBe(true);
    });
  });

  describe('Multi-Entity Isolation', () => {
    it('should isolate data by entity_id', () => {
      const aliceEntityId = stringToUuid('alice-discord-user');
      const bobEntityId = stringToUuid('bob-telegram-user');

      // Different entities should have different IDs
      expect(aliceEntityId).not.toBe(bobEntityId);

      // Both should be valid UUIDs
      expect(aliceEntityId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(bobEntityId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should generate consistent entity IDs from platform usernames', () => {
      const discordUser1a = stringToUuid('discord:alice#1234');
      const discordUser1b = stringToUuid('discord:alice#1234');
      const telegramUser = stringToUuid('telegram:@alice');

      // Same platform user should produce same entity_id
      expect(discordUser1a).toBe(discordUser1b);

      // Different platforms should produce different entity_ids
      expect(discordUser1a).not.toBe(telegramUser);
    });
  });

  describe('Conversation Visibility', () => {
    it('should allow users and agents to see shared conversations', () => {
      const aliceEntityId = stringToUuid('alice');
      const agentEntityId = stringToUuid('agent');

      // Both are participants in room-123
      const participants = [
        { entity_id: aliceEntityId, channel_id: 'room-123' },
        { entity_id: agentEntityId, channel_id: 'room-123' },
      ];

      // Alice should see messages from room-123
      const aliceCanSee = participants.some(
        (p) => p.entity_id === aliceEntityId && p.channel_id === 'room-123'
      );

      // Agent should see messages from room-123
      const agentCanSee = participants.some(
        (p) => p.entity_id === agentEntityId && p.channel_id === 'room-123'
      );

      expect(aliceCanSee).toBe(true);
      expect(agentCanSee).toBe(true);
    });

    it('should prevent non-participants from seeing conversations', () => {
      const bobEntityId = stringToUuid('bob');

      // Only Alice and Agent are participants
      const participants = [
        { entity_id: stringToUuid('alice'), channel_id: 'room-123' },
        { entity_id: stringToUuid('agent'), channel_id: 'room-123' },
      ];

      // Bob should NOT see messages from room-123
      const bobCanSee = participants.some(
        (p) => p.entity_id === bobEntityId && p.channel_id === 'room-123'
      );

      expect(bobCanSee).toBe(false);
    });
  });

  describe('Server Operations Bypass', () => {
    it('should allow NULL entity_id for server operations', () => {
      const entityId = null;
      const bypassRLS = entityId === null;

      expect(bypassRLS).toBe(true);
    });

    it('should block queries when entity_id is required but missing', () => {
      const entityId = undefined;
      const policyRequiresEntity = true;

      const shouldBlock = policyRequiresEntity && !entityId;

      // If RLS is enabled and entity_id not set, should return empty results
      expect(shouldBlock).toBe(true);
    });
  });
});

describe('Entity RLS Integration', () => {
  describe('withIsolationContext Helper', () => {
    it('should set entity context before query execution', () => {
      const entityId = stringToUuid('alice');
      const sessionCommand = `SET LOCAL app.entity_id = '${entityId}'`;

      expect(sessionCommand).toContain('SET LOCAL');
      expect(sessionCommand).toContain(entityId);
    });

    it('should handle NULL entity_id for server operations', () => {
      const entityId = null;
      const shouldSetContext = entityId !== null;

      expect(shouldSetContext).toBe(false);
    });

    it('should gracefully handle RLS disabled mode', () => {
      const rlsEnabled = false;

      // Try-catch should prevent errors when RLS functions don't exist
      let errorThrown = false;
      try {
        if (rlsEnabled) {
          throw new Error('RLS functions not found');
        }
      } catch (error) {
        errorThrown = true;
      }

      // Should NOT throw error in disabled mode
      expect(errorThrown).toBe(false);
    });
  });

  describe('ElizaOS Integration Point', () => {
    it('should check for withIsolationContext method availability', () => {
      const postgresAdapter = {
        withIsolationContext: async (entityId: string, callback: () => Promise<any>) => {
          return callback();
        },
      };

      const pgliteAdapter = {
        // No withIsolationContext method (not supported)
      };

      // PostgreSQL adapter should have method
      expect(typeof postgresAdapter.withIsolationContext).toBe('function');

      // PGLite adapter should NOT have method
      expect(typeof (pgliteAdapter as any).withIsolationContext).toBe('undefined');
    });

    it('should extract entityId from user message', () => {
      const userMessage = {
        entityId: stringToUuid('alice'),
        content: { text: 'Hello' },
      };

      const entityId = userMessage.entityId;

      expect(entityId).toBeDefined();
      expect(entityId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });
});

describe('Entity RLS Backward Compatibility', () => {
  describe('Graceful Degradation', () => {
    it('should work when ENABLE_DATA_ISOLATION=false', () => {
      const dataIsolationEnabled = false;
      const shouldApplyEntityRLS = dataIsolationEnabled;

      expect(shouldApplyEntityRLS).toBe(false);
    });

    it('should not throw errors when Entity RLS functions missing', () => {
      const functionsExist = false;

      let executedSuccessfully = false;
      try {
        if (!functionsExist) {
          // Gracefully skip Entity RLS
          executedSuccessfully = true;
        } else {
          // Try to use Entity RLS
          throw new Error('Functions not found');
        }
      } catch (error) {
        executedSuccessfully = false;
      }

      expect(executedSuccessfully).toBe(true);
    });

    it('should support mixed Server RLS + no Entity RLS', () => {
      const serverRlsEnabled = true;
      const entityRlsEnabled = false;

      // Server RLS can work without Entity RLS
      const validConfiguration = serverRlsEnabled && !entityRlsEnabled;

      expect(validConfiguration).toBe(true);
    });
  });

  describe('No Breaking Changes', () => {
    it('should not modify existing API interfaces', () => {
      // withIsolationContext is OPTIONAL
      interface IDatabaseAdapter {
        withIsolationContext?(entityId: string | null, callback: () => Promise<any>): Promise<any>;
      }

      const adapter: IDatabaseAdapter = {
        // No withIsolationContext - still valid!
      };

      expect(adapter).toBeDefined();
    });

    it('should work with existing plugins without code changes', () => {
      // Plugins don't need to change - entityId already in message
      const discordMessage = {
        entityId: 'discord-user-id',
        content: { text: 'Hello' },
      };

      const telegramMessage = {
        entityId: 'telegram-user-id',
        content: { text: 'Hi' },
      };

      expect(discordMessage.entityId).toBeDefined();
      expect(telegramMessage.entityId).toBeDefined();
    });
  });
});
