/**
 * Tests for cloud/cloud-manager.ts — the top-level orchestrator.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Must mock before importing CloudManager, and use factory functions
// that return class-like constructors so `new` works.
vi.mock("./bridge-client", () => {
  return {
    ElizaCloudClient: class MockElizaCloudClient {
      _baseUrl: string;
      _apiKey: string;
      provision = vi.fn().mockResolvedValue({ id: "a1", status: "running" });
      getAgent = vi.fn().mockResolvedValue({
        id: "a1",
        agentName: "TestBot",
        status: "running",
      });
      snapshot = vi.fn().mockResolvedValue({ id: "bk-1" });
      heartbeat = vi.fn().mockResolvedValue(true);
      constructor(baseUrl: string, apiKey: string) {
        this._baseUrl = baseUrl;
        this._apiKey = apiKey;
      }
    },
  };
});

vi.mock("./cloud-proxy", () => {
  return {
    CloudRuntimeProxy: class MockProxy {
      agentName: string;
      constructor(_client: unknown, _id: string, name: string) {
        this.agentName = name;
      }
    },
  };
});

vi.mock("./backup", () => {
  return {
    BackupScheduler: class MockBackup {
      start = vi.fn();
      stop = vi.fn();
      finalSnapshot = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock("./reconnect", () => {
  return {
    ConnectionMonitor: class MockMonitor {
      start = vi.fn();
      stop = vi.fn();
    },
  };
});

vi.mock("./validate-url", () => {
  return {
    validateCloudBaseUrl: vi.fn().mockResolvedValue(null),
  };
});

import type { CloudConfig } from "../config/types.eliza";
import { CloudManager } from "./cloud-manager";

afterEach(() => {
  vi.clearAllMocks();
});

function cfg(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    enabled: true,
    apiKey: "eliza_testkey",
    baseUrl: "https://test.elizacloud.ai",
    ...overrides,
  };
}

describe("CloudManager", () => {
  describe("init", () => {
    it("creates client from config", async () => {
      const mgr = new CloudManager(cfg());
      await mgr.init();
      expect(mgr.getClient()).not.toBeNull();
    });

    it("throws when apiKey is missing", async () => {
      const mgr = new CloudManager(cfg({ apiKey: undefined }));
      await expect(mgr.init()).rejects.toThrow(
        "Cloud API key is not configured",
      );
    });

    it("strips /api/v1 suffix from baseUrl", async () => {
      const mgr = new CloudManager(
        cfg({ baseUrl: "https://test.elizacloud.ai/api/v1" }),
      );
      await mgr.init();
      expect(
        (mgr.getClient() as unknown as Record<string, string>)._baseUrl,
      ).toBe("https://test.elizacloud.ai");
    });

    it("strips trailing slashes", async () => {
      const mgr = new CloudManager(
        cfg({ baseUrl: "https://test.elizacloud.ai///" }),
      );
      await mgr.init();
      expect(
        (mgr.getClient() as unknown as Record<string, string>)._baseUrl,
      ).toBe("https://test.elizacloud.ai");
    });

    it("defaults to elizacloud.ai when no baseUrl", async () => {
      const mgr = new CloudManager(cfg({ baseUrl: undefined }));
      await mgr.init();
      expect(
        (mgr.getClient() as unknown as Record<string, string>)._baseUrl,
      ).toBe("https://www.elizacloud.ai");
    });
  });

  describe("connect", () => {
    it("provisions and returns proxy", async () => {
      const mgr = new CloudManager(cfg());
      const proxy = await mgr.connect("agent-123");
      expect(proxy.agentName).toBe("TestBot");
      expect(mgr.getActiveAgentId()).toBe("agent-123");
      expect(mgr.getStatus()).toBe("connected");
      expect(mgr.getProxy()).not.toBeNull();
    });

    it("auto-inits if client not ready", async () => {
      const mgr = new CloudManager(cfg());
      expect(mgr.getClient()).toBeNull();
      await mgr.connect("agent-123");
      expect(mgr.getClient()).not.toBeNull();
    });

    it("fires status callbacks", async () => {
      const statuses: string[] = [];
      const mgr = new CloudManager(cfg(), {
        onStatusChange: (s) => statuses.push(s),
      });
      await mgr.connect("agent-123");
      expect(statuses).toContain("connecting");
      expect(statuses).toContain("connected");
    });

    it("resets status and state on connection failure", async () => {
      const mgr = new CloudManager(cfg());
      await mgr.init();

      const state = mgr as unknown as {
        client: { provision: (...args: unknown[]) => Promise<unknown> };
      };
      state.client.provision = vi.fn(async () => {
        throw new Error("provision failed");
      });

      await expect(mgr.connect("agent-123")).rejects.toThrow(
        "provision failed",
      );
      expect(mgr.getStatus()).toBe("disconnected");
      expect(mgr.getActiveAgentId()).toBeNull();
      expect(mgr.getProxy()).toBeNull();
    });
  });

  describe("disconnect", () => {
    it("clears proxy and resets state", async () => {
      const mgr = new CloudManager(cfg());
      await mgr.connect("agent-123");
      await mgr.disconnect();
      expect(mgr.getProxy()).toBeNull();
      expect(mgr.getActiveAgentId()).toBeNull();
      expect(mgr.getStatus()).toBe("disconnected");
    });

    it("fires disconnected callback", async () => {
      const statuses: string[] = [];
      const mgr = new CloudManager(cfg(), {
        onStatusChange: (s) => statuses.push(s),
      });
      await mgr.connect("agent-123");
      statuses.length = 0;
      await mgr.disconnect();
      expect(statuses).toContain("disconnected");
    });
  });

  describe("isEnabled", () => {
    it("true when enabled + apiKey", () => {
      expect(new CloudManager(cfg()).isEnabled()).toBe(true);
    });
    it("false when not enabled", () => {
      expect(new CloudManager(cfg({ enabled: false })).isEnabled()).toBe(false);
    });
    it("false when no apiKey", () => {
      expect(new CloudManager(cfg({ apiKey: undefined })).isEnabled()).toBe(
        false,
      );
    });
  });

  describe("initial state", () => {
    it("proxy is null", () => {
      expect(new CloudManager(cfg()).getProxy()).toBeNull();
    });
    it("client is null", () => {
      expect(new CloudManager(cfg()).getClient()).toBeNull();
    });
    it("agentId is null", () => {
      expect(new CloudManager(cfg()).getActiveAgentId()).toBeNull();
    });
    it("status is disconnected", () => {
      expect(new CloudManager(cfg()).getStatus()).toBe("disconnected");
    });
  });
});
