import { describe, it, expect } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { setScoutClient, getScoutClient, setScoutConfig, getScoutConfig } from "./runtime-store.js";
import type { ScoutClient } from "./client/scout-client.js";
import type { ScoutPluginConfig } from "./config.js";

function makeRuntime(id: string): IAgentRuntime {
  return { agentId: id } as unknown as IAgentRuntime;
}

describe("runtime-store", () => {
  describe("client store", () => {
    it("stores and retrieves client for a runtime", () => {
      const runtime = makeRuntime("agent-1");
      const client = { baseUrl: "test" } as unknown as ScoutClient;
      setScoutClient(runtime, client);
      expect(getScoutClient(runtime)).toBe(client);
    });

    it("returns undefined for unregistered runtime", () => {
      const runtime = makeRuntime("agent-unknown");
      expect(getScoutClient(runtime)).toBeUndefined();
    });

    it("isolates clients between runtimes", () => {
      const rt1 = makeRuntime("agent-1");
      const rt2 = makeRuntime("agent-2");
      const client1 = { id: "c1" } as unknown as ScoutClient;
      const client2 = { id: "c2" } as unknown as ScoutClient;

      setScoutClient(rt1, client1);
      setScoutClient(rt2, client2);

      expect(getScoutClient(rt1)).toBe(client1);
      expect(getScoutClient(rt2)).toBe(client2);
    });
  });

  describe("config store", () => {
    it("stores and retrieves config for a runtime", () => {
      const runtime = makeRuntime("agent-1");
      const config = { apiUrl: "https://test.com" } as ScoutPluginConfig;
      setScoutConfig(runtime, config);
      expect(getScoutConfig(runtime)).toBe(config);
    });

    it("returns undefined for unregistered runtime", () => {
      const runtime = makeRuntime("agent-unknown");
      expect(getScoutConfig(runtime)).toBeUndefined();
    });

    it("isolates configs between runtimes", () => {
      const rt1 = makeRuntime("agent-1");
      const rt2 = makeRuntime("agent-2");
      const config1 = { apiUrl: "https://a.com" } as ScoutPluginConfig;
      const config2 = { apiUrl: "https://b.com" } as ScoutPluginConfig;

      setScoutConfig(rt1, config1);
      setScoutConfig(rt2, config2);

      expect(getScoutConfig(rt1)).toBe(config1);
      expect(getScoutConfig(rt2)).toBe(config2);
    });
  });
});