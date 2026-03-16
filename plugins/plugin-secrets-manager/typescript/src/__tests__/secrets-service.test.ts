/**
 * Integration tests for SecretsService
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretsService } from "../services/secrets";
import { MemorySecretStorage } from "../storage/memory-store";
import { CompositeSecretStorage } from "../storage/interface";
import type { SecretContext } from "../types";

// Mock runtime - create fresh settings object each time to prevent test leakage
const createMockRuntime = (agentId: string = "test-agent") => ({
  agentId,
  getSetting: vi.fn((key: string) => {
    if (key === "ENCRYPTION_SALT") return "test-salt";
    return undefined;
  }),
  character: {
    settings: {}, // Fresh settings object for each test
  },
});

describe("SecretsService", () => {
  let service: SecretsService;
  let mockRuntime: ReturnType<typeof createMockRuntime>;

  beforeEach(async () => {
    mockRuntime = createMockRuntime();
    // Use static start() method which is the correct elizaOS Service pattern
    service = await SecretsService.start(mockRuntime as never);
  });

  afterEach(async () => {
    await service.stop();
  });

  describe("Basic Operations", () => {
    it("should set and get a global secret", async () => {
      const success = await service.setGlobal("TEST_KEY", "test-value");
      expect(success).toBe(true);

      const value = await service.getGlobal("TEST_KEY");
      expect(value).toBe("test-value");
    });

    it("should check if secret exists", async () => {
      const context: SecretContext = {
        level: "global",
        agentId: mockRuntime.agentId,
      };

      expect(await service.exists("TEST_KEY", context)).toBe(false);
      await service.setGlobal("TEST_KEY", "value");
      expect(await service.exists("TEST_KEY", context)).toBe(true);
    });

    it("should delete a secret", async () => {
      await service.setGlobal("TEST_KEY", "value");
      expect(await service.getGlobal("TEST_KEY")).toBe("value");

      const context: SecretContext = {
        level: "global",
        agentId: mockRuntime.agentId,
      };
      const deleted = await service.delete("TEST_KEY", context);
      expect(deleted).toBe(true);
      expect(await service.getGlobal("TEST_KEY")).toBeNull();
    });

    it("should return null for non-existent secret", async () => {
      const value = await service.getGlobal("NON_EXISTENT");
      expect(value).toBeNull();
    });
  });

  describe("Multi-Level Storage", () => {
    // NOTE: World and user secret tests require runtime.getWorld() and runtime.getComponents()
    // which need complex mocking. These are properly tested in runtime-integration.test.ts
    // with a full AgentRuntime instance.

    it.skip("should store secrets at different levels independently", async () => {
      // Skipped: Requires mock runtime with getWorld and getComponents methods
      // See runtime-integration.test.ts for full integration tests
    });

    it.skip("should isolate world secrets by world ID", async () => {
      // Skipped: Requires mock runtime with getWorld method
      // See runtime-integration.test.ts for full integration tests
    });

    it.skip("should isolate user secrets by user ID", async () => {
      // Skipped: Requires mock runtime with getComponents method
      // See runtime-integration.test.ts for full integration tests
    });
  });

  describe("Encryption", () => {
    it("should encrypt and decrypt secrets correctly", async () => {
      const secretValue = "super-secret-api-key-12345";
      await service.setGlobal("ENCRYPTED_KEY", secretValue);

      const retrieved = await service.getGlobal("ENCRYPTED_KEY");
      expect(retrieved).toBe(secretValue);
    });

    it("should handle special characters in secrets", async () => {
      const specialChars = "key!@#$%^&*()_+-=[]{}|;:,.<>?/~`";
      await service.setGlobal("SPECIAL_KEY", specialChars);
      expect(await service.getGlobal("SPECIAL_KEY")).toBe(specialChars);
    });

    it("should handle unicode in secrets", async () => {
      const unicode = "key-日本語-émojis-🔐🔑";
      await service.setGlobal("UNICODE_KEY", unicode);
      expect(await service.getGlobal("UNICODE_KEY")).toBe(unicode);
    });
  });

  describe("Secret Configuration", () => {
    it("should store and retrieve secret config", async () => {
      const context: SecretContext = {
        level: "global",
        agentId: mockRuntime.agentId,
      };

      await service.set("TEST_KEY", "value", context, {
        description: "Test secret",
        type: "api_key",
      });

      const config = await service.getConfig("TEST_KEY", context);
      expect(config).toBeDefined();
      expect(config?.description).toBe("Test secret");
      expect(config?.type).toBe("api_key");
    });

    it("should update secret config", async () => {
      const context: SecretContext = {
        level: "global",
        agentId: mockRuntime.agentId,
      };

      await service.set("TEST_KEY", "value", context);
      await service.updateConfig("TEST_KEY", context, {
        description: "Updated description",
      });

      const config = await service.getConfig("TEST_KEY", context);
      expect(config?.description).toBe("Updated description");
    });
  });

  describe("List Secrets", () => {
    it("should list all secrets for a context", async () => {
      await service.setGlobal("KEY1", "value1");
      await service.setGlobal("KEY2", "value2");
      await service.setGlobal("KEY3", "value3");

      const context: SecretContext = {
        level: "global",
        agentId: mockRuntime.agentId,
      };

      const metadata = await service.list(context);
      // list() returns Record<string, SecretConfig>
      expect(Object.keys(metadata)).toContain("KEY1");
      expect(Object.keys(metadata)).toContain("KEY2");
      expect(Object.keys(metadata)).toContain("KEY3");
      expect(Object.keys(metadata).length).toBe(3);
    });
  });

  describe("Plugin Requirements", () => {
    it("should check plugin requirements correctly", async () => {
      await service.setGlobal("REQUIRED_KEY", "value");

      const requirements = {
        REQUIRED_KEY: {
          key: "REQUIRED_KEY",
          description: "Required key",
          required: true,
          type: "api_key" as const,
        },
        OPTIONAL_KEY: {
          key: "OPTIONAL_KEY",
          description: "Optional key",
          required: false,
          type: "api_key" as const,
        },
        MISSING_REQUIRED: {
          key: "MISSING_REQUIRED",
          description: "Missing required",
          required: true,
          type: "api_key" as const,
        },
      };

      const status = await service.checkPluginRequirements(
        "test-plugin",
        requirements,
      );
      expect(status.ready).toBe(false);
      expect(status.missingRequired).toContain("MISSING_REQUIRED");
      expect(status.missingOptional).toContain("OPTIONAL_KEY");
      expect(status.missingRequired).not.toContain("REQUIRED_KEY");
    });

    it("should report ready when all required secrets are present", async () => {
      await service.setGlobal("KEY1", "value1");
      await service.setGlobal("KEY2", "value2");

      const requirements = {
        KEY1: {
          key: "KEY1",
          description: "Key 1",
          required: true,
          type: "api_key" as const,
        },
        KEY2: {
          key: "KEY2",
          description: "Key 2",
          required: true,
          type: "api_key" as const,
        },
      };

      const status = await service.checkPluginRequirements(
        "test-plugin",
        requirements,
      );
      expect(status.ready).toBe(true);
      expect(status.missingRequired).toHaveLength(0);
    });
  });

  describe("Change Notifications", () => {
    it("should notify on secret change", async () => {
      const callback = vi.fn();
      service.onSecretChanged("TEST_KEY", callback);

      await service.setGlobal("TEST_KEY", "value");

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        "TEST_KEY",
        "value",
        expect.objectContaining({ level: "global" }),
      );
    });

    it("should notify global listeners on any change", async () => {
      const callback = vi.fn();
      service.onAnySecretChanged(callback);

      await service.setGlobal("KEY1", "value1");
      await service.setGlobal("KEY2", "value2");

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should unsubscribe correctly", async () => {
      const callback = vi.fn();
      const unsubscribe = service.onSecretChanged("TEST_KEY", callback);

      await service.setGlobal("TEST_KEY", "value1");
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
      await service.setGlobal("TEST_KEY", "value2");
      expect(callback).toHaveBeenCalledTimes(1); // Still 1, not 2
    });
  });

  describe("Access Logging", () => {
    it("should log access attempts", async () => {
      await service.setGlobal("TEST_KEY", "value");
      await service.getGlobal("TEST_KEY");

      const logs = service.getAccessLogs();
      expect(logs.length).toBeGreaterThan(0);
    });

    it("should filter access logs", async () => {
      await service.setGlobal("KEY1", "value1");
      await service.setGlobal("KEY2", "value2");
      await service.getGlobal("KEY1");

      const key1Logs = service.getAccessLogs({ key: "KEY1" });
      expect(key1Logs.length).toBeGreaterThan(0);
      expect(key1Logs.every((log) => log.secretKey === "KEY1")).toBe(true);
    });
  });
});
