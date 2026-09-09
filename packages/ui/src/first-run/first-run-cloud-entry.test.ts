/** Exercises real onboarding and Cloud HTTP resolution with deterministic transport and local persistence; no live account or runtime is used. */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { loadPersistedActiveServer } from "../state/persistence";
import { bindCloudAgent, type FirstRunFinishPorts } from "./first-run-finish";

vi.mock("../api", async () => {
  const { ElizaClient } = await import("../api/client-base");
  await import("../api/client-cloud");
  return { client: new ElizaClient() };
});
vi.mock("../state", async () => ({
  ...(await import("../state/persistence")),
  addAgentProfile: vi.fn(),
}));

const BASE = "https://api.eliza.app";
const ID = "00000000-0000-4000-8000-000000000020";
const PERSONAL = "personal:00000000-0000-5000-8000-000000000001";
const draft = {
  agentName: "Eliza",
  runtime: "cloud" as const,
  localInference: "cloud-inference" as const,
  remoteApiBase: "",
  remoteToken: "",
};
function ports(): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleInteractiveCloudLogin: vi.fn(),
    setRuntimeState: vi.fn(),
    setTab: vi.fn(),
    completeFirstRun: vi.fn(),
  };
}
function transport(
  status = "running",
  tier = "dedicated-always",
  responseId = ID,
) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        method = init?.method ?? "GET";
      calls.push({ url, method });
      const row = {
        id: responseId,
        name: "Chosen agent",
        status,
        executionTier: tier,
        webUiUrl: `https://${responseId}.cloud.eliza.app`,
      };
      if (method === "GET" && url === `${BASE}/api/v1/eliza/personal`) {
        return Response.json({
          success: true,
          data: {
            identity: { id: PERSONAL, displayName: "Eliza", runtime: "shared" },
          },
        });
      }
      if (method === "GET" && url === `${BASE}/api/v1/eliza/agents/${ID}`) {
        return Response.json({ success: true, data: row });
      }
      if (method === "GET" && url === `${BASE}/api/v1/eliza/agents`) {
        return Response.json({ success: true, data: [row] });
      }
      throw new Error(`Unexpected entry request: ${method} ${url}`);
    },
  );
  return calls;
}
beforeEach(() => {
  localStorage.clear();
  setBootConfig({
    ...getBootConfig(),
    cloudApiBase: BASE,
    preferSharedCloudTier: true,
    autoUpgradeSharedToDedicated: true,
  });
  client.setBaseUrl(BASE);
  client.setToken(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("legacy onboarding selection is read-only", () => {
  it("opens Personal Shared without listing, creating, or pre-warming a runtime", async () => {
    const calls = transport();
    await bindCloudAgent(draft, "test-session", {}, ports());
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${PERSONAL}`,
      cloudRuntime: "shared",
    });
    expect(calls).toEqual([
      { method: "GET", url: `${BASE}/api/v1/eliza/personal` },
    ]);
  });
  it("opens exactly the requested running Dedicated without provisioning or a warm-up request", async () => {
    const calls = transport();
    await bindCloudAgent(draft, "test-session", { preferAgentId: ID }, ports());
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${ID}`,
      apiBase: `https://${ID}.cloud.eliza.app`,
    });
    expect(calls).toEqual([
      { method: "GET", url: `${BASE}/api/v1/eliza/agents/${ID}` },
    ]);
  });
  it.each(["stopped", "sleeping", "error", "provisioning"])(
    "does not wake or replace a requested %s Dedicated",
    async (status) => {
      const calls = transport(status);
      await expect(
        bindCloudAgent(draft, "test-session", { preferAgentId: ID }, ports()),
      ).rejects.toThrow();
      expect(loadPersistedActiveServer()).toBeNull();
      expect(calls).toEqual([
        { method: "GET", url: `${BASE}/api/v1/eliza/agents/${ID}` },
      ]);
    },
  );
  it("rejects a stale create-new intent without any network dispatch", async () => {
    const calls = transport();
    await expect(
      bindCloudAgent(draft, "test-session", { forceCreate: true }, ports()),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(loadPersistedActiveServer()).toBeNull();
  });
  it("does not bind a different agent returned for the requested id", async () => {
    const calls = transport(
      "running",
      "dedicated-always",
      "00000000-0000-4000-8000-000000000021",
    );
    await expect(
      bindCloudAgent(draft, "test-session", { preferAgentId: ID }, ports()),
    ).rejects.toThrow();
    expect(loadPersistedActiveServer()).toBeNull();
    expect(calls).toEqual([
      { method: "GET", url: `${BASE}/api/v1/eliza/agents/${ID}` },
    ]);
  });
});
