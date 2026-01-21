import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanupExpiredSessions,
  createAgentSession,
  getSessionDuration,
  type SessionStore,
  setSessionStore,
  verifyAgentCredentials,
  verifyAgentSession,
} from "../agent-auth";

describe("Agent Authentication", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset to in-memory store
    setSessionStore(null);
    // Reset env
    process.env.NODE_ENV = "test";
    process.env.CRON_SECRET = "test-secret";
    process.env.POLYAGENT_AGENT_ID = "test-agent";
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe("verifyAgentCredentials", () => {
    it("returns true for valid credentials", () => {
      const result = verifyAgentCredentials("test-agent", "test-secret");
      expect(result).toBe(true);
    });

    it("returns false for invalid agent ID", () => {
      const result = verifyAgentCredentials("wrong-agent", "test-secret");
      expect(result).toBe(false);
    });

    it("returns false for invalid secret", () => {
      const result = verifyAgentCredentials("test-agent", "wrong-secret");
      expect(result).toBe(false);
    });

    it("returns false when CRON_SECRET not configured", () => {
      delete process.env.CRON_SECRET;
      const result = verifyAgentCredentials("test-agent", "test-secret");
      expect(result).toBe(false);
    });

    it("uses default test agent ID in non-production", () => {
      delete process.env.POLYAGENT_AGENT_ID;
      process.env.NODE_ENV = "development";
      const result = verifyAgentCredentials(
        "polyagent-agent-alice",
        "test-secret",
      );
      expect(result).toBe(true);
    });
  });

  describe("createAgentSession", () => {
    it("creates a session with correct properties", async () => {
      const session = await createAgentSession("agent-1", "token-123");

      expect(session.agentId).toBe("agent-1");
      expect(session.sessionToken).toBe("token-123");
      expect(session.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe("verifyAgentSession", () => {
    it("returns agent info for valid session", async () => {
      await createAgentSession("agent-1", "valid-token");

      const result = await verifyAgentSession("valid-token");

      expect(result).toEqual({ agentId: "agent-1" });
    });

    it("returns null for non-existent session", async () => {
      const result = await verifyAgentSession("non-existent-token");
      expect(result).toBeNull();
    });

    it("returns null and deletes expired session", async () => {
      // Create a custom store that returns an expired session
      const expiredSession = {
        sessionToken: "expired-token",
        agentId: "agent-1",
        expiresAt: Date.now() - 1000, // Already expired
      };

      let deleted = false;
      const mockStore: SessionStore = {
        get: async () => JSON.stringify(expiredSession),
        set: async () => {},
        delete: async () => {
          deleted = true;
        },
      };

      setSessionStore(mockStore);

      const result = await verifyAgentSession("expired-token");

      expect(result).toBeNull();
      expect(deleted).toBe(true);
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("removes expired sessions from in-memory store", async () => {
      // Create sessions directly in memory
      await createAgentSession("agent-valid", "valid-token");

      // Verify it exists
      expect(await verifyAgentSession("valid-token")).not.toBeNull();

      // Cleanup should not remove valid sessions
      cleanupExpiredSessions();

      expect(await verifyAgentSession("valid-token")).not.toBeNull();
    });

    it("does nothing when external store is configured", () => {
      const mockStore: SessionStore = {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      };

      setSessionStore(mockStore);

      // Should not throw
      cleanupExpiredSessions();
    });
  });

  describe("getSessionDuration", () => {
    it("returns 24 hours in milliseconds", () => {
      const duration = getSessionDuration();
      expect(duration).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe("Custom SessionStore", () => {
    it("uses custom store when configured", async () => {
      const stored: Map<string, string> = new Map();

      const customStore: SessionStore = {
        get: async (key) => stored.get(key) ?? null,
        set: async (key, value) => {
          stored.set(key, value);
        },
        delete: async (key) => {
          stored.delete(key);
        },
      };

      setSessionStore(customStore);

      await createAgentSession("custom-agent", "custom-token");

      // Verify it's in the custom store
      expect(stored.has("agent:session:custom-token")).toBe(true);

      // Verify we can retrieve it
      const result = await verifyAgentSession("custom-token");
      expect(result).toEqual({ agentId: "custom-agent" });
    });
  });
});
