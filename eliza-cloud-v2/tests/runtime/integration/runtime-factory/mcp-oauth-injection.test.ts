/**
 * MCP OAuth Injection Integration Tests
 *
 * Tests that MCP servers are dynamically injected based on user OAuth connections.
 * This verifies the production code path: UserContext -> RuntimeFactory -> MCP plugin injection.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  getConnectionString,
  verifyConnection,
  createTestDataSet,
  cleanupTestData,
  type TestDataSet,
  runtimeFactory,
  invalidateRuntime,
  AgentMode,
  buildUserContext,
} from "../../../infrastructure";
import type { UserContext } from "../../../../lib/eliza/user-context";
import { Client } from "pg";
import { v4 as uuidv4 } from "uuid";

let connectionString: string;
let testData: TestDataSet;

async function setupEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 MCP OAuth Injection Tests");
  console.log("=".repeat(60));

  const connected = await verifyConnection();
  if (!connected) {
    throw new Error("Cannot connect to database");
  }
  connectionString = getConnectionString();

  testData = await createTestDataSet(connectionString, {
    organizationName: "MCP OAuth Test Org",
    userName: "MCP OAuth Test User",
    userEmail: `mcp-oauth-test-${Date.now()}@eliza.test`,
    creditBalance: 100.0,
  });
  console.log("✅ Test data created");
}

async function cleanupEnvironment(): Promise<void> {
  console.log("\n🧹 Cleaning up...");
  if (testData) {
    // Clean up OAuth sessions first
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        `DELETE FROM oauth_sessions WHERE organization_id = $1`,
        [testData.organization.id]
      );
    } catch (e) {
      console.warn(`OAuth cleanup warning: ${e}`);
    } finally {
      await client.end();
    }

    await cleanupTestData(connectionString, testData.organization.id).catch(
      (err) => console.warn(`Cleanup warning: ${err}`)
    );
  }
}

/**
 * Create a mock OAuth session in the database
 * This simulates a user who has connected their Google account
 */
async function createOAuthSession(
  orgId: string,
  userId: string,
  provider: string
): Promise<string> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const sessionId = uuidv4();
    // Insert minimal OAuth session - we don't need real tokens for this test
    // The MCP injection only checks if connections exist, not the actual tokens
    await client.query(
      `INSERT INTO oauth_sessions (
        id, organization_id, user_id, provider,
        encrypted_access_token, encryption_key_id, encrypted_dek, nonce, auth_tag,
        is_valid
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
      [
        sessionId,
        orgId,
        userId,
        provider,
        "mock_encrypted_token", // Not used - MCP injection just checks existence
        "mock_key_id",
        "mock_dek",
        "mock_nonce",
        "mock_auth_tag",
      ]
    );
    return sessionId;
  } finally {
    await client.end();
  }
}

/**
 * Helper to get MCP settings from runtime.
 * MCP settings are now stored in runtime.settings (ephemeral) to avoid DB persistence.
 */
function getMcpSettings(runtime: any): { servers?: Record<string, unknown> } | undefined {
  // Check runtime.settings first (ephemeral settings - where MCP config now lives)
  // Fall back to character.settings for backwards compatibility
  return runtime.settings?.mcp || runtime.character?.settings?.mcp;
}

describe("MCP OAuth Injection", () => {
  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should NOT inject MCP plugin when user has no OAuth connections", async () => {
    // Create context WITHOUT oauth connections
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.ASSISTANT,
      webSearchEnabled: false,
    });

    // Ensure no oauthConnections property
    expect(userContext.oauthConnections).toBeUndefined();

    const runtime = await runtimeFactory.createRuntimeForUser(userContext);

    try {
      // MCP service should NOT be present (or not have our oauth-based servers)
      const mcpService = runtime.getService("mcp");

      // The MCP plugin may or may not be loaded depending on character config
      // What we're testing is that NO oauth-based MCP servers are configured
      const mcpSettings = getMcpSettings(runtime);

      // Should not have google server injected
      if (mcpSettings?.servers) {
        expect(mcpSettings.servers.google).toBeUndefined();
      }

      console.log("✅ No OAuth-based MCP servers injected for user without connections");
    } finally {
      await invalidateRuntime(runtime.agentId as string);
    }
  }, 60000);

  it("should inject MCP plugin when user has Google OAuth connection", async () => {
    // Create OAuth session in database
    await createOAuthSession(
      testData.organization.id,
      testData.user.id,
      "google"
    );

    // Create context WITH oauth connections
    const userContext: UserContext = {
      ...buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
        webSearchEnabled: false,
      }),
      oauthConnections: [{ platform: "google" }],
    };

    const runtime = await runtimeFactory.createRuntimeForUser(userContext);

    try {
      // Check that MCP settings include google server
      const mcpSettings = getMcpSettings(runtime);

      expect(mcpSettings).toBeDefined();
      expect(mcpSettings?.servers).toBeDefined();
      expect(mcpSettings?.servers?.google).toBeDefined();

      const googleServer = mcpSettings?.servers?.google as { url?: string; type?: string };
      expect(googleServer.url).toContain("/api/mcps/google/mcp");
      expect(googleServer.type).toBe("streamable-http");

      console.log("✅ Google MCP server injected for user with OAuth connection");
      console.log(`   Server URL: ${googleServer.url}`);
    } finally {
      await invalidateRuntime(runtime.agentId as string);
    }
  }, 60000);

  it("should inject API key header for same-origin MCP servers", async () => {
    const userContext: UserContext = {
      ...buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
        webSearchEnabled: false,
      }),
      oauthConnections: [{ platform: "google" }],
    };

    const runtime = await runtimeFactory.createRuntimeForUser(userContext);

    try {
      const mcpSettings = getMcpSettings(runtime);

      expect(mcpSettings).toBeDefined();
      expect(mcpSettings?.servers?.google).toBeDefined();

      const googleServer = mcpSettings?.servers?.google as {
        url?: string;
        headers?: Record<string, string>;
      };

      // Should have API key header injected for same-origin requests
      expect(googleServer.headers).toBeDefined();
      expect(googleServer.headers?.["X-API-Key"]).toBeDefined();
      expect(googleServer.headers?.["X-API-Key"]).toBe(testData.apiKey.key);

      console.log("✅ API key header injected for same-origin MCP server");
    } finally {
      await invalidateRuntime(runtime.agentId as string);
    }
  }, 60000);

  it("should not inject MCP for unsupported platforms", async () => {
    // Test with a platform that's not in MCP_SERVER_CONFIGS
    const userContext: UserContext = {
      ...buildUserContext(testData, {
        agentMode: AgentMode.ASSISTANT,
        webSearchEnabled: false,
      }),
      oauthConnections: [{ platform: "linkedin" }], // Not supported
    };

    const runtime = await runtimeFactory.createRuntimeForUser(userContext);

    try {
      const mcpSettings = getMcpSettings(runtime);

      // Should not have linkedin server (not in config)
      if (mcpSettings?.servers) {
        expect(mcpSettings.servers.linkedin).toBeUndefined();
      }

      console.log("✅ Unsupported platform OAuth connection does not inject MCP server");
    } finally {
      await invalidateRuntime(runtime.agentId as string);
    }
  }, 60000);
});
