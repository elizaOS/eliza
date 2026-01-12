/**
 * Integration tests for the Roblox plugin.
 * Skip tests that require API keys.
 */

import { describe, expect, it } from "vitest";

const HAS_API_KEY = !!process.env.ROBLOX_API_KEY;
const _skipIfNoKey = HAS_API_KEY ? it : it.skip;

describe("Roblox Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export robloxPlugin", async () => {
      const { robloxPlugin } = await import("../index");
      expect(robloxPlugin).toBeDefined();
      expect(robloxPlugin.name).toBe("roblox");
    }, 30000); // Increase timeout for dynamic import

    it("should have correct description", async () => {
      const { robloxPlugin } = await import("../index");
      expect(robloxPlugin.description).toContain("Roblox");
    });

    it("should have services defined", async () => {
      const { robloxPlugin } = await import("../index");
      expect(robloxPlugin.services).toBeDefined();
      expect(Array.isArray(robloxPlugin.services)).toBe(true);
    });

    it("should have providers defined", async () => {
      const { robloxPlugin } = await import("../index");
      expect(robloxPlugin.providers).toBeDefined();
      expect(Array.isArray(robloxPlugin.providers)).toBe(true);
    });

    it("should have actions defined", async () => {
      const { robloxPlugin } = await import("../index");
      expect(robloxPlugin.actions).toBeDefined();
      expect(Array.isArray(robloxPlugin.actions)).toBe(true);
    });

    it("should have init function", async () => {
      const { robloxPlugin } = await import("../index");
      expect(typeof robloxPlugin.init).toBe("function");
    });

    it("should have tests defined", async () => {
      const { robloxPlugin } = await import("../index");
      expect(robloxPlugin.tests).toBeDefined();
    });
  });

  describe("Actions", () => {
    it("should export robloxActions", async () => {
      const { robloxActions } = await import("../actions");
      expect(robloxActions).toBeDefined();
      expect(Array.isArray(robloxActions)).toBe(true);
    });
  });

  describe("Providers", () => {
    it("should export robloxProviders", async () => {
      const { robloxProviders } = await import("../providers");
      expect(robloxProviders).toBeDefined();
      expect(Array.isArray(robloxProviders)).toBe(true);
    });
  });

  describe("Service", () => {
    it("should export RobloxService", async () => {
      const { RobloxService } = await import("../services/RobloxService");
      expect(RobloxService).toBeDefined();
    });
  });

  describe("Client", () => {
    it("should export RobloxClient", async () => {
      const { RobloxClient } = await import("../client/RobloxClient");
      expect(RobloxClient).toBeDefined();
    });
  });
});
