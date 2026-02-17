/**
 * Plugin structure tests — verifies the exported plugin has all
 * expected components registered correctly.
 */

import { describe, expect, it } from "vitest";
import { elizaOSCloudPlugin } from "../index.js";

describe("elizaOS Cloud Plugin", () => {
  describe("Plugin metadata", () => {
    it("has correct name", () => {
      expect(elizaOSCloudPlugin.name).toBe("elizaOSCloud");
    });

    it("has description mentioning cloud", () => {
      expect(elizaOSCloudPlugin.description).toContain("Cloud");
    });

    it("has init function", () => {
      expect(typeof elizaOSCloudPlugin.init).toBe("function");
    });

    it("has config defined", () => {
      expect(elizaOSCloudPlugin.config).toBeDefined();
    });
  });

  describe("Config keys", () => {
    const config = elizaOSCloudPlugin.config ?? {};

    it("includes API key config", () => {
      expect("ELIZAOS_CLOUD_API_KEY" in config).toBe(true);
    });

    it("includes base URL config", () => {
      expect("ELIZAOS_CLOUD_BASE_URL" in config).toBe(true);
    });

    it("includes ELIZAOS_CLOUD_ENABLED config", () => {
      expect("ELIZAOS_CLOUD_ENABLED" in config).toBe(true);
    });

    it("includes model configs", () => {
      expect("ELIZAOS_CLOUD_SMALL_MODEL" in config).toBe(true);
      expect("ELIZAOS_CLOUD_LARGE_MODEL" in config).toBe(true);
      expect("ELIZAOS_CLOUD_EMBEDDING_MODEL" in config).toBe(true);
    });
  });

  describe("Model handlers", () => {
    const models = elizaOSCloudPlugin.models ?? {};

    it("registers TEXT_EMBEDDING handler", () => {
      expect(typeof models.TEXT_EMBEDDING).toBe("function");
    });

    it("registers TEXT_SMALL handler", () => {
      expect(typeof models.TEXT_SMALL).toBe("function");
    });

    it("registers TEXT_LARGE handler", () => {
      expect(typeof models.TEXT_LARGE).toBe("function");
    });

    it("registers IMAGE handler", () => {
      expect(typeof models.IMAGE).toBe("function");
    });

    it("registers IMAGE_DESCRIPTION handler", () => {
      expect(typeof models.IMAGE_DESCRIPTION).toBe("function");
    });

    it("registers OBJECT_SMALL handler", () => {
      expect(typeof models.OBJECT_SMALL).toBe("function");
    });

    it("registers OBJECT_LARGE handler", () => {
      expect(typeof models.OBJECT_LARGE).toBe("function");
    });
  });

  describe("Cloud services", () => {
    const services = elizaOSCloudPlugin.services ?? [];

    it("registers 4 cloud services", () => {
      expect(services).toHaveLength(4);
    });

    it("includes CloudAuthService", () => {
      expect(services.some((s) => (s as { serviceType?: string }).serviceType === "CLOUD_AUTH")).toBe(true);
    });

    it("includes CloudContainerService", () => {
      expect(services.some((s) => (s as { serviceType?: string }).serviceType === "CLOUD_CONTAINER")).toBe(true);
    });

    it("includes CloudBridgeService", () => {
      expect(services.some((s) => (s as { serviceType?: string }).serviceType === "CLOUD_BRIDGE")).toBe(true);
    });

    it("includes CloudBackupService", () => {
      expect(services.some((s) => (s as { serviceType?: string }).serviceType === "CLOUD_BACKUP")).toBe(true);
    });

    it("CloudAuthService is registered first (other services depend on it)", () => {
      expect((services[0] as { serviceType?: string }).serviceType).toBe("CLOUD_AUTH");
    });
  });

  describe("Cloud actions", () => {
    const actions = elizaOSCloudPlugin.actions ?? [];

    it("registers 4 cloud actions", () => {
      expect(actions).toHaveLength(4);
    });

    it("includes PROVISION_CLOUD_AGENT", () => {
      expect(actions.some((a) => a.name === "PROVISION_CLOUD_AGENT")).toBe(true);
    });

    it("includes FREEZE_CLOUD_AGENT", () => {
      expect(actions.some((a) => a.name === "FREEZE_CLOUD_AGENT")).toBe(true);
    });

    it("includes RESUME_CLOUD_AGENT", () => {
      expect(actions.some((a) => a.name === "RESUME_CLOUD_AGENT")).toBe(true);
    });

    it("includes CHECK_CLOUD_CREDITS", () => {
      expect(actions.some((a) => a.name === "CHECK_CLOUD_CREDITS")).toBe(true);
    });

    it("all actions have validate and handler functions", () => {
      for (const action of actions) {
        expect(typeof action.validate).toBe("function");
        expect(typeof action.handler).toBe("function");
      }
    });

    it("all actions have descriptions", () => {
      for (const action of actions) {
        expect(action.description.length).toBeGreaterThan(10);
      }
    });

    it("all actions have tags", () => {
      for (const action of actions) {
        expect(action.tags?.length).toBeGreaterThan(0);
        expect(action.tags).toContain("cloud");
      }
    });
  });

  describe("Cloud providers", () => {
    const providers = elizaOSCloudPlugin.providers ?? [];

    it("registers 3 cloud providers", () => {
      expect(providers).toHaveLength(3);
    });

    it("includes elizacloud_status", () => {
      expect(providers.some((p) => p.name === "elizacloud_status")).toBe(true);
    });

    it("includes elizacloud_credits", () => {
      expect(providers.some((p) => p.name === "elizacloud_credits")).toBe(true);
    });

    it("includes elizacloud_health (private)", () => {
      const health = providers.find((p) => p.name === "elizacloud_health");
      expect(health).toBeDefined();
      expect(health?.private).toBe(true);
    });

    it("all providers have get functions", () => {
      for (const provider of providers) {
        expect(typeof provider.get).toBe("function");
      }
    });

    it("providers are ordered by position", () => {
      const positions = providers.map((p) => p.position ?? 0);
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
      }
    });
  });

  describe("Inline test suites", () => {
    it("has test suites defined", () => {
      expect(Array.isArray(elizaOSCloudPlugin.tests)).toBe(true);
      expect(elizaOSCloudPlugin.tests!.length).toBeGreaterThan(0);
    });

    it("has ELIZAOS_CLOUD_plugin_tests suite", () => {
      const suite = elizaOSCloudPlugin.tests?.find((t) => t.name === "ELIZAOS_CLOUD_plugin_tests");
      expect(suite).toBeDefined();
      expect(suite!.tests.length).toBeGreaterThan(5);
    });
  });
});
