#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_PROJECT_DIR="$SCRIPT_DIR/test-agent"
ELIZA_REPO_DIR="$(cd "$SCRIPT_DIR/../../../../../.." && pwd)"
POSTGRES_URL="postgresql://postgres:postgres@localhost:5433/migration_test"
STATE_BEFORE_FILE="$SCRIPT_DIR/.state_before.txt"
STATE_AFTER_FILE="$SCRIPT_DIR/.state_after.txt"
LOG_LEVEL=debug

# ============================================
# SOURCE VERSION - Change this to test different versions
# ============================================
# Examples: 1.6.2, 1.6.3, 1.6.4
SOURCE_VERSION="${SOURCE_VERSION:-1.6.3}"

# macOS compatible timeout function
run_with_timeout() {
  local timeout=$1
  shift
  # Run command in background
  "$@" &
  local pid=$!
  # Wait for timeout or completion
  ( sleep $timeout && kill $pid 2>/dev/null ) &
  local killer=$!
  wait $pid 2>/dev/null
  kill $killer 2>/dev/null || true
}

# Function to capture complete database state
capture_db_state() {
  local output_file=$1
  local label=$2

  echo "=== DATABASE STATE: $label ===" > "$output_file"
  echo "" >> "$output_file"

  # List all tables
  echo "--- TABLES ---" >> "$output_file"
  docker exec migration-test-postgres psql -U postgres -d migration_test -t -c "
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name;
  " >> "$output_file" 2>/dev/null || echo "(no tables)" >> "$output_file"

  echo "" >> "$output_file"

  # For each key table, show columns
  for table in rooms memories worlds agents entities participants components relationships cache embeddings logs tasks; do
    echo "--- TABLE: $table ---" >> "$output_file"
    docker exec migration-test-postgres psql -U postgres -d migration_test -t -c "
      SELECT column_name || ' (' || data_type || ')' as col
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '$table'
      ORDER BY ordinal_position;
    " 2>/dev/null | grep -v "^$" >> "$output_file" || echo "(table not exists)" >> "$output_file"
    echo "" >> "$output_file"
  done

  # Data counts
  echo "--- DATA COUNTS ---" >> "$output_file"
  docker exec migration-test-postgres psql -U postgres -d migration_test -t -c "
    SELECT 'agents: ' || COUNT(*) FROM agents
    UNION ALL SELECT 'rooms: ' || COUNT(*) FROM rooms
    UNION ALL SELECT 'memories: ' || COUNT(*) FROM memories
    UNION ALL SELECT 'worlds: ' || COUNT(*) FROM worlds;
  " 2>/dev/null | grep -v "^$" >> "$output_file" || echo "(no data)" >> "$output_file"

  echo "" >> "$output_file"

  # Sample room data
  echo "--- SAMPLE ROOM DATA ---" >> "$output_file"
  docker exec migration-test-postgres psql -U postgres -d migration_test -c "
    SELECT * FROM rooms LIMIT 1;
  " 2>/dev/null >> "$output_file" || echo "(no rooms)" >> "$output_file"
}

# Function to display state with colors
display_state() {
  local file=$1
  local color=$2

  while IFS= read -r line; do
    if [[ $line == "==="* ]]; then
      echo -e "${color}${line}${NC}"
    elif [[ $line == "---"* ]]; then
      echo -e "${CYAN}${line}${NC}"
    else
      echo -e "${color}${line}${NC}"
    fi
  done < "$file"
}

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Migration Upgrade Test v${SOURCE_VERSION} → local (Local Build)      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo -e "${CYAN}  Source version: ${SOURCE_VERSION}${NC}"
echo -e "${CYAN}  Usage: SOURCE_VERSION=1.6.4 ./run-upgrade-test.sh${NC}"

# Step 1: Start PostgreSQL
echo -e "\n${YELLOW}▶ Step 1: Starting PostgreSQL...${NC}"
cd "$SCRIPT_DIR"
docker compose down -v 2>/dev/null || true
docker compose up -d
echo -e "${GREEN}✓ PostgreSQL started on port 5433${NC}"

# Wait for PostgreSQL to be ready
echo -e "${YELLOW}  Waiting for PostgreSQL to be ready...${NC}"
for i in {1..30}; do
  if docker exec migration-test-postgres pg_isready -U postgres > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
    break
  fi
  echo -n "."
  sleep 1
done

# Step 2: Create test project directory
echo -e "\n${YELLOW}▶ Step 2: Creating test project...${NC}"
rm -rf "$TEST_PROJECT_DIR"
mkdir -p "$TEST_PROJECT_DIR"

# Step 3: Setup source version environment
echo -e "\n${YELLOW}▶ Step 3: Setting up v${SOURCE_VERSION} environment...${NC}"

# Create package.json for source version
cat > "$TEST_PROJECT_DIR/package.json" << EOF
{
  "name": "migration-test-agent",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "elizaos start --character=./character.json",
    "seed": "bun run seed-data.ts"
  },
  "dependencies": {
    "@elizaos/cli": "${SOURCE_VERSION}",
    "@elizaos/plugin-bootstrap": "${SOURCE_VERSION}",
    "@elizaos/plugin-sql": "${SOURCE_VERSION}"
  }
}
EOF

# Create simple character file
cat > "$TEST_PROJECT_DIR/character.json" << 'EOF'
{
  "name": "MigrationTestAgent",
  "username": "migration_test",
  "system": "You are a test agent for migration testing.",
  "bio": ["A simple test agent"],
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-sql"]
}
EOF

# Create .env file
cat > "$TEST_PROJECT_DIR/.env" << EOF
POSTGRES_URL=$POSTGRES_URL
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-sk-or-v1-test}
OPENROUTER_SMALL_MODEL=openai/gpt-4.1-nano
OPENROUTER_LARGE_MODEL=openai/gpt-4.1-mini
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
OPENROUTER_EMBEDDING_DIMENSIONS=1536
LOG_LEVEL=info
EOF

# Create FULLY DYNAMIC seed data script - works with ANY version
# Introspects the database schema and builds INSERT statements dynamically
cat > "$TEST_PROJECT_DIR/seed-data.ts" << 'EOF'
import postgres from 'postgres';

const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5433/migration_test';

interface ColumnInfo {
  name: string;
  type: string;
}

interface TableSchema {
  columns: ColumnInfo[];
  exists: boolean;
}

// Get all columns and their types for a table
async function getTableSchema(client: any, tableName: string): Promise<TableSchema> {
  const result = await client`
    SELECT column_name, data_type, udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position
  `;
  return {
    columns: result.map((r: any) => ({
      name: r.column_name,
      type: r.data_type === 'ARRAY' ? r.udt_name : r.data_type  // e.g., '_text' for text[]
    })),
    exists: result.length > 0
  };
}

// Find which column name exists (tries multiple variants) - returns column info
function findColumn(schema: TableSchema, ...variants: string[]): ColumnInfo | null {
  for (const v of variants) {
    const col = schema.columns.find(c => c.name === v);
    if (col) return col;
  }
  return null;
}

// Check if column is an array type
function isArrayColumn(col: ColumnInfo): boolean {
  return col.type.startsWith('_');  // PostgreSQL uses _text for text[], _int4 for int[], etc.
}

// Build INSERT statement dynamically based on available columns
function buildInsert(
  tableName: string,
  schema: TableSchema,
  data: Record<string, any>
): { sql: string; values: any[] } | null {
  // Filter data to only include columns that exist in the schema
  const availableCols: string[] = [];
  const availableVals: any[] = [];

  for (const [key, value] of Object.entries(data)) {
    // Try to find the column (could be camelCase or snake_case)
    const col = findColumn(schema, key);
    if (col && value !== undefined) {
      availableCols.push(`"${col}"`);
      availableVals.push(value);
    }
  }

  if (availableCols.length === 0) return null;

  const placeholders = availableVals.map((_, i) => `$${i + 1}`).join(', ');
  return {
    sql: `INSERT INTO "${tableName}" (${availableCols.join(', ')}) VALUES (${placeholders})`,
    values: availableVals
  };
}

async function seedData() {
  console.log('🌱 DYNAMIC SEED - Works with ANY schema version');
  console.log('   Introspecting database schema...\n');

  const client = postgres(POSTGRES_URL);
  const stats: Record<string, number> = {};

  try {
    // ============================================
    // INTROSPECT ALL TABLES
    // ============================================
    console.log('🔍 Discovering schema...');
    const tables = ['agents', 'worlds', 'rooms', 'entities', 'memories',
                    'participants', 'relationships', 'components', 'logs', 'tasks', 'cache'];

    const schemas: Record<string, TableSchema> = {};
    for (const table of tables) {
      schemas[table] = await getTableSchema(client, table);
      if (schemas[table].exists) {
        const colNames = schemas[table].columns.map(c => c.name);
        console.log(`   ✓ ${table}: ${colNames.length} columns`);
      } else {
        console.log(`   ✗ ${table}: not found`);
      }
    }
    console.log('');

    // ============================================
    // TEST DATA IDs
    // ============================================
    const agentId = '11111111-1111-1111-1111-111111111111';
    const agentId2 = '11111111-1111-1111-1111-111111111112';
    const worldId = '44444444-4444-4444-4444-444444444444';
    const worldId2 = '44444444-4444-4444-4444-444444444445';
    const roomId = '22222222-2222-2222-2222-222222222222';
    const roomId2 = '22222222-2222-2222-2222-222222222223';
    const roomId3 = '22222222-2222-2222-2222-222222222224';
    const entityId = '55555555-5555-5555-5555-555555555551';
    const entityId2 = '55555555-5555-5555-5555-555555555552';
    const entityId3 = '55555555-5555-5555-5555-555555555553';

    // ============================================
    // HELPER: Insert with schema detection
    // ============================================
    async function smartInsert(tableName: string, dataRows: Record<string, any>[]) {
      if (!schemas[tableName]?.exists) {
        console.log(`   ⊘ ${tableName}: table not found, skipping`);
        return 0;
      }

      let count = 0;
      for (const data of dataRows) {
        // Map common column name variants with type info
        const mappedData: Record<string, { value: any; colInfo: ColumnInfo }> = {};
        for (const [key, value] of Object.entries(data)) {
          // Try camelCase, snake_case, and exact
          const snakeCase = key.replace(/([A-Z])/g, '_$1').toLowerCase();
          const colInfo = findColumn(schemas[tableName], key, snakeCase);
          if (colInfo && !mappedData[colInfo.name]) {
            mappedData[colInfo.name] = { value, colInfo };
          }
        }

        const cols = Object.keys(mappedData).filter(k => mappedData[k].value !== undefined);
        if (cols.length === 0) continue;

        const colNames = cols.map(c => `"${c}"`).join(', ');
        const values = cols.map(c => {
          const { value, colInfo } = mappedData[c];
          // For array columns, convert JS array to PostgreSQL array literal
          if (isArrayColumn(colInfo) && Array.isArray(value)) {
            return '{' + value.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(',') + '}';
          }
          // For jsonb, stringify the object
          if (colInfo.type === 'jsonb' && typeof value === 'object') {
            return JSON.stringify(value);
          }
          return value;
        });
        const placeholders = cols.map((c, i) => {
          const { colInfo } = mappedData[c];
          if (isArrayColumn(colInfo)) return `$${i + 1}::text[]`;
          if (colInfo.type === 'jsonb') return `$${i + 1}::jsonb`;
          if (colInfo.type === 'uuid') return `$${i + 1}::uuid`;
          return `$${i + 1}`;
        }).join(', ');

        try {
          await client.unsafe(`INSERT INTO "${tableName}" (${colNames}) VALUES (${placeholders})`, values);
          count++;
        } catch (err: any) {
          console.log(`   ⚠ ${tableName} insert failed: ${err.message?.slice(0, 60)}`);
        }
      }
      stats[tableName] = count;
      return count;
    }

    // ============================================
    // 1. AGENTS
    // ============================================
    await smartInsert('agents', [
      { id: agentId, name: 'Test Agent 1', username: 'test_agent_1', enabled: true },
      { id: agentId2, name: 'Test Agent 2', username: 'test_agent_2', enabled: true }
    ]);
    console.log(`✓ agents: ${stats.agents || 0} records`);

    // ============================================
    // 2. WORLDS
    // ============================================
    await smartInsert('worlds', [
      { id: worldId, agentId: agentId, agent_id: agentId, name: 'Test World 1', serverId: 'world-server-789', server_id: 'world-server-789' },
      { id: worldId2, agentId: agentId2, agent_id: agentId2, name: 'Test World 2', serverId: 'another-server', server_id: 'another-server' }
    ]);
    console.log(`✓ worlds: ${stats.worlds || 0} records`);

    // ============================================
    // 3. ROOMS
    // ============================================
    await smartInsert('rooms', [
      { id: roomId, agentId: agentId, agent_id: agentId, worldId: worldId, world_id: worldId, name: 'General Chat', source: 'discord', type: 'GROUP', serverId: 'server-123', server_id: 'server-123', channelId: 'channel-456', channel_id: 'channel-456' },
      { id: roomId2, agentId: agentId, agent_id: agentId, worldId: worldId, world_id: worldId, name: 'Private DM', source: 'telegram', type: 'DM', serverId: 'server-789', server_id: 'server-789', channelId: 'channel-abc', channel_id: 'channel-abc' },
      { id: roomId3, agentId: agentId2, agent_id: agentId2, worldId: worldId2, world_id: worldId2, name: 'Another Room', source: 'slack', type: 'GROUP', serverId: 'slack-srv', server_id: 'slack-srv', channelId: 'slack-ch', channel_id: 'slack-ch' }
    ]);
    console.log(`✓ rooms: ${stats.rooms || 0} records`);

    // ============================================
    // 4. ENTITIES
    // ============================================
    await smartInsert('entities', [
      { id: entityId, agentId: agentId, agent_id: agentId, names: ['Alice', 'alice123'], metadata: { role: 'user' } },
      { id: entityId2, agentId: agentId, agent_id: agentId, names: ['Bob', 'bob456'], metadata: { role: 'admin' } },
      { id: entityId3, agentId: agentId2, agent_id: agentId2, names: ['Charlie'], metadata: { role: 'guest' } }
    ]);
    console.log(`✓ entities: ${stats.entities || 0} records`);

    // ============================================
    // 5. MEMORIES
    // ============================================
    const memoryRows = [];
    for (let i = 1; i <= 10; i++) {
      memoryRows.push({
        id: `33333333-3333-3333-3333-3333333333${i.toString().padStart(2, '0')}`,
        agentId: agentId, agent_id: agentId,
        roomId: roomId, room_id: roomId,
        entityId: entityId, entity_id: entityId,
        worldId: worldId, world_id: worldId,
        content: { text: `Test memory message ${i}` },
        type: 'message',
        unique: i % 2 === 0,
        metadata: { importance: i }
      });
    }
    await smartInsert('memories', memoryRows);
    console.log(`✓ memories: ${stats.memories || 0} records`);

    // ============================================
    // 6. PARTICIPANTS
    // ============================================
    await smartInsert('participants', [
      { id: '66666666-6666-6666-6666-666666666661', entityId: entityId, entity_id: entityId, roomId: roomId, room_id: roomId, agentId: agentId, agent_id: agentId, roomState: 'ACTIVE', room_state: 'ACTIVE' },
      { id: '66666666-6666-6666-6666-666666666662', entityId: entityId2, entity_id: entityId2, roomId: roomId, room_id: roomId, agentId: agentId, agent_id: agentId, roomState: 'MUTED', room_state: 'MUTED' },
      { id: '66666666-6666-6666-6666-666666666663', entityId: entityId, entity_id: entityId, roomId: roomId2, room_id: roomId2, agentId: agentId, agent_id: agentId, roomState: 'ACTIVE', room_state: 'ACTIVE' },
      { id: '66666666-6666-6666-6666-666666666664', entityId: entityId3, entity_id: entityId3, roomId: roomId3, room_id: roomId3, agentId: agentId2, agent_id: agentId2, roomState: 'ACTIVE', room_state: 'ACTIVE' }
    ]);
    console.log(`✓ participants: ${stats.participants || 0} records`);

    // ============================================
    // 7. RELATIONSHIPS
    // ============================================
    await smartInsert('relationships', [
      { id: '77777777-7777-7777-7777-777777777771', sourceEntityId: entityId, source_entity_id: entityId, targetEntityId: entityId2, target_entity_id: entityId2, agentId: agentId, agent_id: agentId, tags: ['friend'], metadata: { trust: 0.8 } },
      { id: '77777777-7777-7777-7777-777777777772', sourceEntityId: entityId2, source_entity_id: entityId2, targetEntityId: entityId, target_entity_id: entityId, agentId: agentId, agent_id: agentId, tags: ['friend'], metadata: { trust: 0.9 } },
      { id: '77777777-7777-7777-7777-777777777773', sourceEntityId: entityId, source_entity_id: entityId, targetEntityId: entityId3, target_entity_id: entityId3, agentId: agentId, agent_id: agentId, tags: ['acquaintance'], metadata: { trust: 0.5 } }
    ]);
    console.log(`✓ relationships: ${stats.relationships || 0} records`);

    // ============================================
    // 8. COMPONENTS
    // ============================================
    await smartInsert('components', [
      { id: '88888888-8888-8888-8888-888888888881', entityId: entityId, entity_id: entityId, agentId: agentId, agent_id: agentId, roomId: roomId, room_id: roomId, worldId: worldId, world_id: worldId, type: 'profile', data: { bio: 'Test user' } },
      { id: '88888888-8888-8888-8888-888888888882', entityId: entityId2, entity_id: entityId2, agentId: agentId, agent_id: agentId, roomId: roomId, room_id: roomId, worldId: worldId, world_id: worldId, type: 'settings', data: { theme: 'dark' } },
      { id: '88888888-8888-8888-8888-888888888883', entityId: entityId3, entity_id: entityId3, agentId: agentId2, agent_id: agentId2, roomId: roomId3, room_id: roomId3, worldId: worldId2, world_id: worldId2, type: 'badge', data: { level: 5 } }
    ]);
    console.log(`✓ components: ${stats.components || 0} records`);

    // ============================================
    // 9. LOGS
    // ============================================
    await smartInsert('logs', [
      { id: '99999999-9999-9999-9999-999999999991', entityId: entityId, entity_id: entityId, roomId: roomId, room_id: roomId, body: { action: 'message_sent' }, type: 'ACTION' },
      { id: '99999999-9999-9999-9999-999999999992', entityId: entityId2, entity_id: entityId2, roomId: roomId, room_id: roomId, body: { action: 'joined_room' }, type: 'EVENT' },
      { id: '99999999-9999-9999-9999-999999999993', entityId: entityId, entity_id: entityId, roomId: roomId2, room_id: roomId2, body: { error: 'rate_limited' }, type: 'ERROR' }
    ]);
    console.log(`✓ logs: ${stats.logs || 0} records`);

    // ============================================
    // 10. TASKS
    // ============================================
    await smartInsert('tasks', [
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Process messages', description: 'Background task', roomId: roomId, room_id: roomId, worldId: worldId, world_id: worldId, entityId: entityId, entity_id: entityId, agentId: agentId, agent_id: agentId, tags: ['background'], metadata: { priority: 1 } },
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', name: 'Sync data', description: 'Sync task', roomId: roomId2, room_id: roomId2, worldId: worldId, world_id: worldId, agentId: agentId, agent_id: agentId, tags: ['sync'], metadata: { priority: 2 } },
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac', name: 'Cleanup', description: 'Cleanup task', agentId: agentId2, agent_id: agentId2, tags: ['maintenance'], metadata: { priority: 3 } }
    ]);
    console.log(`✓ tasks: ${stats.tasks || 0} records`);

    // ============================================
    // 11. CACHE
    // ============================================
    await smartInsert('cache', [
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', key: 'user_prefs_alice', agentId: agentId, agent_id: agentId, value: { theme: 'dark' } },
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', key: 'session_data_bob', agentId: agentId, agent_id: agentId, value: { token: 'abc123' } },
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbd', key: 'api_response_cache', agentId: agentId2, agent_id: agentId2, value: { data: [1, 2, 3] } }
    ]);
    console.log(`✓ cache: ${stats.cache || 0} records`);

    // ============================================
    // SUMMARY
    // ============================================
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    console.log('\n' + '='.repeat(60));
    console.log('📊 SEED DATA SUMMARY:');
    console.log('='.repeat(60));
    for (const [table, count] of Object.entries(stats)) {
      console.log(`  ${table.padEnd(15)} ${count} records`);
    }
    console.log('='.repeat(60));
    console.log(`  TOTAL:         ${total} records`);
    console.log('='.repeat(60));
    console.log('\n✅ Dynamic seed complete!');

  } catch (error) {
    console.error('❌ Error seeding data:', error);
    throw error;
  } finally {
    await client.end();
  }
}

seedData().catch(console.error);
EOF

echo -e "${GREEN}✓ Test project created${NC}"

# Step 4: Install source version dependencies
echo -e "\n${YELLOW}▶ Step 4: Installing v${SOURCE_VERSION} dependencies...${NC}"
cd "$TEST_PROJECT_DIR"
bun install
echo -e "${GREEN}✓ v${SOURCE_VERSION} dependencies installed${NC}"

# Step 5: Initialize database with source version schema
echo -e "\n${YELLOW}▶ Step 5: Initializing v${SOURCE_VERSION} database schema...${NC}"
run_with_timeout 30 bun run start 2>&1 || true
echo -e "${GREEN}✓ v${SOURCE_VERSION} schema initialized${NC}"

# Step 6: Seed test data
echo -e "\n${YELLOW}▶ Step 6: Seeding test data...${NC}"
bun add postgres
bun run seed
echo -e "${GREEN}✓ Test data seeded${NC}"

# Step 7: Capture BEFORE state
echo -e "\n${YELLOW}▶ Step 7: Capturing v${SOURCE_VERSION} database state...${NC}"
capture_db_state "$STATE_BEFORE_FILE" "v${SOURCE_VERSION} (BEFORE migration)"

echo -e "\n${MAGENTA}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║                    STATE BEFORE MIGRATION                      ║${NC}"
echo -e "${MAGENTA}║                        (v${SOURCE_VERSION})                                ║${NC}"
echo -e "${MAGENTA}╚════════════════════════════════════════════════════════════════╝${NC}"
display_state "$STATE_BEFORE_FILE" "$MAGENTA"

# Step 8: Upgrade to local build
echo -e "\n${YELLOW}▶ Step 8: Upgrading to local workspace...${NC}"
echo -e "${GREEN}  Using workspace-linked packages from: $ELIZA_REPO_DIR/packages/*${NC}"

# Update package.json to use workspaces for local packages
cat > "$TEST_PROJECT_DIR/package.json" << EOF
{
  "name": "migration-test-agent",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "elizaos start --character=./character.json",
    "verify": "bun run verify-data.ts"
  },
  "workspaces": [
    "$ELIZA_REPO_DIR/packages/*"
  ],
  "dependencies": {
    "@elizaos/cli": "workspace:*",
    "@elizaos/plugin-bootstrap": "workspace:*",
    "@elizaos/plugin-sql": "workspace:*",
    "postgres": "^3.4.5"
  }
}
EOF

# Create comprehensive verification script
cat > "$TEST_PROJECT_DIR/verify-data.ts" << 'EOF'
import postgres from 'postgres';

const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5433/migration_test';

// Define expected column migrations per table
const EXPECTED_MIGRATIONS = {
  rooms: {
    renames: ['agentId→agent_id', 'worldId→world_id', 'channelId→channel_id', 'createdAt→created_at', 'serverId→message_server_id'],
    expectedCount: 3
  },
  worlds: {
    renames: ['agentId→agent_id', 'createdAt→created_at', 'serverId→message_server_id'],
    expectedCount: 2
  },
  memories: {
    renames: ['agentId→agent_id', 'roomId→room_id', 'entityId→entity_id', 'worldId→world_id', 'createdAt→created_at'],
    expectedCount: 10
  },
  entities: {
    renames: ['agentId→agent_id', 'createdAt→created_at'],
    expectedCount: 3
  },
  participants: {
    renames: ['entityId→entity_id', 'roomId→room_id', 'agentId→agent_id', 'roomState→room_state', 'createdAt→created_at'],
    expectedCount: 4
  },
  relationships: {
    renames: ['sourceEntityId→source_entity_id', 'targetEntityId→target_entity_id', 'agentId→agent_id', 'createdAt→created_at'],
    expectedCount: 3
  },
  components: {
    renames: ['entityId→entity_id', 'agentId→agent_id', 'roomId→room_id', 'worldId→world_id', 'sourceEntityId→source_entity_id', 'createdAt→created_at'],
    expectedCount: 3
  },
  logs: {
    renames: ['entityId→entity_id', 'roomId→room_id', 'createdAt→created_at'],
    expectedCount: 3
  },
  tasks: {
    renames: ['roomId→room_id', 'worldId→world_id', 'entityId→entity_id', 'createdAt→created_at', 'updatedAt→updated_at'],
    expectedCount: 3
  },
  cache: {
    renames: ['agentId→agent_id', 'createdAt→created_at', 'expiresAt→expires_at'],
    expectedCount: 3
  }
};

async function verifyData() {
  console.log('🔍 Comprehensive verification after migration...\n');
  console.log('='.repeat(70));

  const client = postgres(POSTGRES_URL);

  try {
    const errors: string[] = [];
    const successes: string[] = [];
    let totalRecordsBefore = 0;
    let totalRecordsAfter = 0;

    for (const [tableName, config] of Object.entries(EXPECTED_MIGRATIONS)) {
      console.log(`\n📋 Checking table: ${tableName}`);
      console.log('-'.repeat(40));

      // Get current columns
      const columns = await client`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = ${tableName}
        ORDER BY ordinal_position
      `;
      const columnNames = columns.map(c => c.column_name);

      // Check each expected rename
      for (const rename of config.renames) {
        const [oldName, newName] = rename.split('→');
        const hasOld = columnNames.includes(oldName);
        const hasNew = columnNames.includes(newName);

        if (hasNew && !hasOld) {
          successes.push(`${tableName}: ${oldName} → ${newName}`);
          console.log(`   ✓ ${oldName} → ${newName}`);
        } else if (hasOld && !hasNew) {
          errors.push(`${tableName}: ${oldName} not renamed to ${newName}`);
          console.log(`   ✗ ${oldName} not renamed (still camelCase)`);
        } else if (hasOld && hasNew) {
          errors.push(`${tableName}: Both ${oldName} and ${newName} exist`);
          console.log(`   ⚠ Both ${oldName} and ${newName} exist`);
        } else {
          // Neither exists - might be OK if column was optional
          console.log(`   ○ ${newName} (column not present)`);
        }
      }

      // Check data count
      const countResult = await client.unsafe(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const count = Number(countResult[0].count);
      totalRecordsAfter += count;
      totalRecordsBefore += config.expectedCount;

      if (count >= config.expectedCount) {
        successes.push(`${tableName}: ${count}/${config.expectedCount} records preserved`);
        console.log(`   ✓ Data: ${count} records (expected ≥${config.expectedCount})`);
      } else {
        errors.push(`${tableName}: Only ${count}/${config.expectedCount} records`);
        console.log(`   ✗ Data: ${count} records (expected ≥${config.expectedCount}) - DATA LOST!`);
      }
    }

    // Check special tables/renames
    console.log(`\n📋 Checking special migrations`);
    console.log('-'.repeat(40));

    // Check owners table is dropped
    const ownersExists = await client`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'owners'
    `;
    if (ownersExists.length === 0) {
      successes.push('owners table dropped (migrated to servers)');
      console.log('   ✓ owners table dropped');
    } else {
      errors.push('owners table still exists');
      console.log('   ✗ owners table still exists');
    }

    // Check servers table exists
    const serversExists = await client`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'servers'
    `;
    if (serversExists.length > 0) {
      successes.push('servers table created');
      console.log('   ✓ servers table exists');
    } else {
      errors.push('servers table missing');
      console.log('   ✗ servers table missing');
    }

    // Check message_server_id is UUID type
    const messageServerIdType = await client`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'rooms' AND column_name = 'message_server_id'
    `;
    if (messageServerIdType.length > 0 && messageServerIdType[0].data_type === 'uuid') {
      successes.push('rooms.message_server_id is UUID type');
      console.log('   ✓ rooms.message_server_id is UUID');
    } else {
      const actualType = messageServerIdType[0]?.data_type || 'missing';
      errors.push(`rooms.message_server_id is ${actualType}, expected uuid`);
      console.log(`   ✗ rooms.message_server_id is ${actualType} (expected uuid)`);
    }

    // Check worlds.message_server_id is UUID type
    const worldsMessageServerIdType = await client`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'worlds' AND column_name = 'message_server_id'
    `;
    if (worldsMessageServerIdType.length > 0 && worldsMessageServerIdType[0].data_type === 'uuid') {
      successes.push('worlds.message_server_id is UUID type');
      console.log('   ✓ worlds.message_server_id is UUID');
    } else {
      const actualType = worldsMessageServerIdType[0]?.data_type || 'missing';
      errors.push(`worlds.message_server_id is ${actualType}, expected uuid`);
      console.log(`   ✗ worlds.message_server_id is ${actualType} (expected uuid)`);
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 VERIFICATION SUMMARY');
    console.log('='.repeat(70));
    console.log(`   Tables checked:     ${Object.keys(EXPECTED_MIGRATIONS).length}`);
    console.log(`   Total records:      ${totalRecordsAfter} (expected ≥${totalRecordsBefore})`);
    console.log(`   Successful checks:  ${successes.length}`);
    console.log(`   Errors:             ${errors.length}`);
    console.log('='.repeat(70));

    if (errors.length > 0) {
      console.log('\n❌ ERRORS DETECTED:');
      errors.forEach(e => console.log(`   ✗ ${e}`));
      console.log('\n');
      process.exit(1);
    }

    console.log('\n🎉 ALL MIGRATIONS SUCCESSFUL! Data integrity verified.\n');

  } catch (error) {
    console.error('❌ Error verifying data:', error);
    throw error;
  } finally {
    await client.end();
  }
}

verifyData().catch(e => {
  console.error(e);
  process.exit(1);
});
EOF

bun install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Step 9: Run agent with local build (triggers migration)
echo -e "\n${YELLOW}▶ Step 9: Running agent with local build (migration will run)...${NC}"
echo -e "${BLUE}  Running: bun run start (using workspace-linked @elizaos/plugin-sql)${NC}"
run_with_timeout 60 bun run start 2>&1 || true
echo -e "${GREEN}✓ Local agent ran (migration executed)${NC}"

# Step 10: Capture AFTER state
echo -e "\n${YELLOW}▶ Step 10: Capturing database state after migration...${NC}"
capture_db_state "$STATE_AFTER_FILE" "local (AFTER migration)"

echo -e "\n${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    STATE AFTER MIGRATION                       ║${NC}"
echo -e "${GREEN}║                        (local build)                           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
display_state "$STATE_AFTER_FILE" "$GREEN"

# Step 11: Show DIFF
echo -e "\n${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                      MIGRATION DIFF                            ║${NC}"
echo -e "${CYAN}║              (camelCase → snake_case changes)                  ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"

echo -e "\n${YELLOW}Columns renamed in 'rooms' table:${NC}"
echo -e "  ${RED}- agentId (text)${NC}      →  ${GREEN}+ agent_id (uuid)${NC}"
echo -e "  ${RED}- createdAt (timestamp)${NC} →  ${GREEN}+ created_at (timestamp)${NC}"
echo -e "  ${RED}- channelId (text)${NC}    →  ${GREEN}+ channel_id (text)${NC}"
echo -e "  ${RED}- serverId (text)${NC}     →  ${GREEN}+ message_server_id (uuid)${NC}"

echo -e "\n${YELLOW}Full diff (BEFORE vs AFTER):${NC}"
diff --color=always -u "$STATE_BEFORE_FILE" "$STATE_AFTER_FILE" 2>/dev/null || true

# Step 12: Run verification
echo -e "\n${YELLOW}▶ Step 11: Running verification...${NC}"
cd "$TEST_PROJECT_DIR"
bun run verify

echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║              Migration Test Complete!                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"

# Cleanup temp files
rm -f "$STATE_BEFORE_FILE" "$STATE_AFTER_FILE"

echo -e "\n${YELLOW}To cleanup:${NC}"
echo "  cd $SCRIPT_DIR && docker compose down -v"
echo "  rm -rf $TEST_PROJECT_DIR"
