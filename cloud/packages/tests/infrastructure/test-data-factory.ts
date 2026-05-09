/**
 * Test Data Factory
 *
 * Creates test data (users, organizations, api keys, characters)
 * directly in the database using the cloud repositories.
 * This replicates the production data model for realistic integration testing.
 */

import { Client } from "pg";
import { v4 as uuidv4 } from "uuid";

export interface TestOrganization {
  id: string;
  name: string;
  slug: string;
  creditBalance: number;
}

export interface TestUser {
  id: string;
  stewardUserId: string;
  email: string;
  name: string;
  organizationId: string;
  isAnonymous: boolean;
}

export interface TestApiKey {
  id: string;
  name: string;
  key: string;
  keyHash: string;
  keyPrefix: string;
  organizationId: string;
  userId: string;
}

export interface TestCharacter {
  id: string;
  name: string;
  userId: string;
  isPublic: boolean;
  characterData: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface TestDataSet {
  organization: TestOrganization;
  user: TestUser;
  apiKey: TestApiKey;
  character?: TestCharacter;
}

/**
 * Create a complete test data set with org, user, and api key
 */
export async function createTestDataSet(
  connectionString: string,
  options: {
    organizationName?: string;
    userName?: string;
    userEmail?: string;
    creditBalance?: number;
    includeCharacter?: boolean;
    characterName?: string;
    characterData?: Record<string, unknown>;
    characterSettings?: Record<string, unknown>;
  } = {},
): Promise<TestDataSet> {
  const {
    organizationName = `Test Org ${uuidv4().slice(0, 8)}`,
    userName = `Test User`,
    userEmail = `test-${uuidv4().slice(0, 8)}@test.local`,
    creditBalance = 100.0,
    includeCharacter = false,
    characterName = "Test Character",
    characterData = {},
    characterSettings = {},
  } = options;

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Create organization
    const orgId = uuidv4();
    const orgSlug = `test-org-${uuidv4().slice(0, 8)}`;

    await client.query(
      `INSERT INTO organizations (id, name, slug, credit_balance, is_active, settings)
       VALUES ($1, $2, $3, $4, true, '{}')`,
      [orgId, organizationName, orgSlug, creditBalance],
    );

    const organization: TestOrganization = {
      id: orgId,
      name: organizationName,
      slug: orgSlug,
      creditBalance,
    };

    // Create user
    const userId = uuidv4();
    const stewardUserId = `test:user:${userId}`;

    await client.query(
      `INSERT INTO users (id, steward_user_id, email, name, organization_id, role, is_anonymous, is_active)
       VALUES ($1, $2, $3, $4, $5, 'owner', false, true)`,
      [userId, stewardUserId, userEmail, userName, orgId],
    );

    const user: TestUser = {
      id: userId,
      stewardUserId,
      email: userEmail,
      name: userName,
      organizationId: orgId,
      isAnonymous: false,
    };

    // Create API key
    const apiKeyId = uuidv4();
    const apiKeyValue = `eliza_test_${uuidv4().replace(/-/g, "")}`;
    const apiKeyHash = await hashApiKey(apiKeyValue);
    const apiKeyPrefix = apiKeyValue.slice(0, 12);

    await client.query(
      `INSERT INTO api_keys (id, name, description, key, key_hash, key_prefix, organization_id, user_id, permissions, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]', true)`,
      [
        apiKeyId,
        "Test API Key",
        "API key for integration testing",
        apiKeyValue,
        apiKeyHash,
        apiKeyPrefix,
        orgId,
        userId,
      ],
    );

    const apiKey: TestApiKey = {
      id: apiKeyId,
      name: "Test API Key",
      key: apiKeyValue,
      keyHash: apiKeyHash,
      keyPrefix: apiKeyPrefix,
      organizationId: orgId,
      userId,
    };

    // Optionally create character
    let character: TestCharacter | undefined;
    if (includeCharacter) {
      const characterId = uuidv4();

      // Table is named user_characters in the cloud schema
      // Required fields: id, organization_id, user_id, name, bio, character_data
      await client.query(
        `INSERT INTO user_characters (id, user_id, organization_id, name, bio, is_public, character_data, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          characterId,
          userId,
          orgId,
          characterName,
          JSON.stringify((characterData as { bio?: string })?.bio || "Test character bio"),
          true,
          JSON.stringify(characterData),
          JSON.stringify(characterSettings),
        ],
      );

      character = {
        id: characterId,
        name: characterName,
        userId,
        isPublic: true,
        characterData,
        settings: characterSettings,
      };
    }

    console.log(`[TestDataFactory] Created test data set:`);
    console.log(`  Organization: ${organization.name} (${organization.id})`);
    console.log(`  User: ${user.email} (${user.id})`);
    console.log(`  API Key: ${apiKey.keyPrefix}...`);
    if (character) {
      console.log(`  Character: ${character.name} (${character.id})`);
    }

    return { organization, user, apiKey, character };
  } finally {
    await client.end();
  }
}

/**
 * Create a test room in the cloud database
 * Note: Rooms are primarily managed by elizaOS, this is for cloud-specific room tracking
 */
export async function createTestRoom(
  connectionString: string,
  options: {
    userId: string;
    agentId?: string;
    name?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; name: string }> {
  // Note: elizaOS manages rooms via plugin-sql
  // This function is a placeholder for future cloud room integration
  const { name = `Test Room ${uuidv4().slice(0, 8)}` } = options;
  const roomId = uuidv4();
  console.log(`[TestDataFactory] Room ID generated: ${name} (${roomId})`);
  return { id: roomId, name };
}

/**
 * Create an anonymous session for testing
 */
export async function createAnonymousSession(
  connectionString: string,
  options: {
    messageLimit?: number;
  } = {},
): Promise<{ sessionToken: string; userId: string; sessionId: string }> {
  const { messageLimit = 10 } = options;

  const client = new Client({ connectionString });
  await client.connect();

  try {
    // First create an anonymous user
    const userId = uuidv4();
    const orgId = uuidv4();
    const sessionToken = `anon_${uuidv4().replace(/-/g, "")}`;
    const stewardUserId = `test:anonymous:${userId}`;

    // Create org for anonymous user
    await client.query(
      `INSERT INTO organizations (id, name, slug, credit_balance, is_active, settings)
       VALUES ($1, $2, $3, $4, true, '{}')`,
      [orgId, "Anonymous Org", `anon-org-${uuidv4().slice(0, 8)}`, 0],
    );

    // Create anonymous user
    await client.query(
      `INSERT INTO users (id, steward_user_id, is_anonymous, organization_id, role, is_active, anonymous_session_id)
       VALUES ($1, $2, true, $3, 'member', true, $4)`,
      [userId, stewardUserId, orgId, sessionToken],
    );

    // Create anonymous session
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await client.query(
      `INSERT INTO anonymous_sessions (id, session_token, user_id, messages_limit, expires_at, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [sessionId, sessionToken, userId, messageLimit, expiresAt],
    );

    console.log(`[TestDataFactory] Created anonymous session: ${sessionToken.slice(0, 12)}...`);
    return { sessionToken, userId, sessionId };
  } finally {
    await client.end();
  }
}

/**
 * Clean up test data by organization ID
 */
export async function cleanupTestData(
  connectionString: string,
  organizationId: string,
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Delete in order respecting foreign keys
    await client.query(`DELETE FROM api_keys WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM user_characters WHERE organization_id = $1`, [organizationId]);
    await client.query(
      `DELETE FROM anonymous_sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)`,
      [organizationId],
    );
    await client.query(`DELETE FROM users WHERE organization_id = $1`, [organizationId]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);

    console.log(`[TestDataFactory] Cleaned up test data for org: ${organizationId}`);
  } finally {
    await client.end();
  }
}

/**
 * Delete all tasks for a given agent from the database.
 * Call this before creating test runtimes to prevent stale tasks from previous
 * test runs from being picked up by the new runtime's task scheduler.
 */
export async function cleanupAgentTasks(connectionString: string, agentId: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`DELETE FROM tasks WHERE "agent_id" = $1`, [agentId]);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[TestDataFactory] Deleted ${result.rowCount} stale tasks for agent: ${agentId}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Hash an API key (simple implementation for testing)
 */
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const testDataFactory = {
  createTestDataSet,
  createTestRoom,
  createAnonymousSession,
  cleanupTestData,
};

export default testDataFactory;
