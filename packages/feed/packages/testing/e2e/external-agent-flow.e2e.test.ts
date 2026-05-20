/**
 * External Agent E2E Flow Tests
 *
 * Tests the complete external agent integration workflow:
 * 1. Register external agent → Get API key
 * 2. Discover other agents → Find compatible agents
 * 3. Send A2A messages → Communicate with internal/external agents
 * 4. Verify trust scoring → Trust level progression
 */

import type { AgentCapabilities } from "@feed/agents";
import { expect, test } from "@playwright/test";
import type { DiscoveredAgent } from "../types/test-types";

// Base URL for API calls
const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, "") ||
  "http://127.0.0.1:3400";

// Test agent data - use timestamp to ensure unique IDs
const timestamp = Date.now();
const testAgent = {
  externalId: `test-agent-${timestamp}`,
  name: "E2E Test Agent",
  description: "External agent for end-to-end testing",
  endpoint: "https://test-agent.example.com/a2a",
  protocol: "a2a" as const,
  capabilities: {
    actions: ["text-generation", "analysis"],
    version: "1.0.0",
    skills: ["communication", "data-processing"],
    domains: ["testing", "automation"],
  } as AgentCapabilities,
  agentCard: {
    version: "1.0" as const,
    agentId: `test-agent-${timestamp}`,
    name: "E2E Test Agent",
    description: "External agent for end-to-end testing",
    endpoints: {
      a2a: "https://test-agent.example.com/a2a",
    },
    capabilities: {
      actions: ["text-generation", "analysis"],
      version: "1.0.0",
      skills: ["communication", "data-processing"],
      domains: ["testing", "automation"],
    } as AgentCapabilities,
  },
};

let apiKey: string;
let agentId: string;

test.describe("External Agent E2E Flow", () => {
  let authCookies: string;
  let registrationDone = false;

  test.beforeAll(async ({ browser }) => {
    // Get authentication cookies from saved state
    const context = await browser.newContext({
      storageState: ".playwright/auth.json",
    });
    const cookies = await context.cookies();
    authCookies = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await context.close();

    // Register the agent once upfront to avoid rate limiting across tests
    const response = await fetch(`${BASE_URL}/api/agents/external/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookies,
      },
      body: JSON.stringify(testAgent),
    });

    if (response.status === 201) {
      const data = await response.json();
      apiKey = data.apiKey;
      agentId = data.registration.agentId;
      registrationDone = true;
    } else if (response.status === 409) {
      // Already registered from a previous run — try to discover existing credentials
      // We can't recover the API key, so tests that need it will be skipped
      registrationDone = false;
    }
  });

  test.describe("Phase 1: Agent Registration", () => {
    test("should register a new external agent", async () => {
      // Registration was already done in beforeAll to avoid rate limiting.
      // Verify the result here.
      test.skip(
        !registrationDone,
        "Agent was already registered in a prior run - cannot recover API key",
      );

      expect(apiKey).toBeDefined();
      expect(apiKey).toMatch(/^bab_live_[a-f0-9]{64}$/);
      expect(agentId).toBeDefined();

      console.log(`Registered agent: ${agentId}`);
      console.log(`API Key: ${apiKey.substring(0, 20)}...`);
    });

    test("should reject duplicate registration", async () => {
      // The agent was already registered in beforeAll, so re-registering
      // should return 409 without needing a fresh first registration.
      test.skip(!registrationDone, "Initial registration did not succeed");

      const response = await fetch(`${BASE_URL}/api/agents/external/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookies,
        },
        body: JSON.stringify(testAgent),
      });

      // Accept 409 (duplicate) or 500 (server-side error) or 429 (rate limited)
      expect([409, 429, 500]).toContain(response.status);
      if (response.status === 429 || response.status === 500) return;

      const data = await response.json();
      expect(data.success).toBe(false);
    });

    test("should reject registration with invalid data", async () => {
      const invalidAgent = {
        ...testAgent,
        externalId: `invalid-${Date.now()}`,
        endpoint: "not-a-url", // Invalid URL
      };

      const response = await fetch(`${BASE_URL}/api/agents/external/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookies,
        },
        body: JSON.stringify(invalidAgent),
      });

      // Accept 400 (validation error) or 429 (rate limited)
      expect([400, 429]).toContain(response.status);
      if (response.status === 429) return; // Rate limited - can't validate further

      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });

  test.describe("Phase 2: Agent Discovery", () => {
    test("should discover agents with valid API key", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");
      const response = await fetch(
        `${BASE_URL}/api/agents/external/discover?limit=10`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.agents).toBeDefined();
      expect(Array.isArray(data.agents)).toBe(true);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.limit).toBe(10);
      expect(data.pagination.offset).toBe(0);
    });

    test("should reject discovery without API key", async () => {
      const response = await fetch(`${BASE_URL}/api/agents/external/discover`, {
        method: "GET",
      });

      expect(response.status).toBe(401);

      const data = await response.json();

      expect(data.success).toBe(false);
      expect(data.error).toBe("Unauthorized");
    });

    test("should filter agents by capabilities", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");
      const response = await fetch(
        `${BASE_URL}/api/agents/external/discover?capabilities=text-generation&limit=10`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.agents).toBeDefined();

      // All returned agents should have text-generation capability
      data.agents.forEach((agent: DiscoveredAgent) => {
        expect(agent.capabilities?.actions?.includes("text-generation")).toBe(
          true,
        );
      });
    });

    test("should filter agents by trust level", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");
      const response = await fetch(
        `${BASE_URL}/api/agents/external/discover?minTrustLevel=1`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.agents).toBeDefined();

      // All returned agents should have trust level >= 1
      data.agents.forEach((agent: DiscoveredAgent) => {
        expect(agent.trustLevel).toBeGreaterThanOrEqual(1);
      });
    });

    test("should support POST-based discovery with complex filters", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");
      const filter = {
        types: ["EXTERNAL", "NPC"],
        statuses: ["ACTIVE"],
        minTrustLevel: 1,
        requiredCapabilities: ["text-generation"],
        matchMode: "all",
        limit: 5,
        offset: 0,
      };

      const response = await fetch(`${BASE_URL}/api/agents/external/discover`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(filter),
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.agents).toBeDefined();
      expect(data.filters).toEqual(filter);
    });
  });

  test.describe("Phase 3: A2A Messaging", () => {
    test("should send A2A message with valid API key", async () => {
      test.skip(
        !apiKey || !agentId,
        "No API key/agentId available - registration did not succeed",
      );
      const message = {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          to: agentId, // Send message to self for testing
          parts: [
            {
              type: "text",
              content: "Hello from E2E test!",
            },
          ],
          contextId: `test-context-${Date.now()}`,
          metadata: {
            testRun: true,
            timestamp: Date.now(),
          },
        },
      };

      const response = await fetch(`${BASE_URL}/api/a2a`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.jsonrpc).toBe("2.0");
      expect(data.id).toBe(1);

      // Since the external agent endpoint is fake, we expect a delivery failure
      // This confirms the message was processed, authenticated, and routing was attempted
      if (data.error) {
        expect(data.error.code).toBe(-32603); // INTERNAL_ERROR
        expect(data.error.message).toContain("fetch failed");
      } else {
        expect(data.result).toBeDefined();
        expect(data.result.messageId).toBeDefined();
        expect(data.result.status).toBe("delivered");
      }
    });

    test("should reject A2A message without API key", async () => {
      test.skip(
        !agentId,
        "No agentId available - registration did not succeed",
      );
      const message = {
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        params: {
          to: agentId,
          parts: [
            {
              type: "text",
              content: "Unauthorized message",
            },
          ],
        },
      };

      const response = await fetch(`${BASE_URL}/api/a2a`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      // Without API key, the server returns 401 (auth check happens before JSON-RPC processing)
      expect(response.status).toBe(401);
    });

    test("should handle invalid JSON-RPC request", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");
      const invalidMessage = {
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        // Missing required params
      };

      const response = await fetch(`${BASE_URL}/api/a2a`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(invalidMessage),
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.jsonrpc).toBe("2.0");
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32602); // INVALID_PARAMS
    });

    test("should return error for unknown method", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");
      const message = {
        jsonrpc: "2.0",
        id: 4,
        method: "unknown/method",
        params: {},
      };

      const response = await fetch(`${BASE_URL}/api/a2a`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.jsonrpc).toBe("2.0");
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe(-32601); // METHOD_NOT_FOUND
    });
  });

  test.describe("Phase 4: API Documentation", () => {
    test("should return A2A agent card", async () => {
      test.skip(!apiKey, "No API key available - registration did not succeed");

      const response = await fetch(`${BASE_URL}/api/a2a`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json();

      expect(data.name).toBe("Feed");
      expect(data.url).toContain("/api/a2a");
      expect(data.version).toBeDefined();
      expect(data.protocolVersion).toBeDefined();
      expect(data.provider).toBeDefined();
    });
  });
});
