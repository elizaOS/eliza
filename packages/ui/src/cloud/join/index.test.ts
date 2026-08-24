/**
 * Verifies the join domain barrel (`./index`): every runtime export resolves to
 * the real underlying implementation, and the behaviours reachable through the
 * barrel — cloud-route registration, Cloud connection resolution, the join flow
 * controller's validation and persistence contract, and the Steward session
 * hook's localStorage fallback — behave as their modules define.
 */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "../../config/boot-config";
import { getCloudRoute, listCloudRoutes } from "../shell/cloud-route-registry";
import * as joinBarrel from "./index";
import {
  JOIN_ROUTE_PATH,
  type JoinFlowClient,
  type JoinFlowEffects,
  type JoinFlowResult,
  registerJoinFlow,
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
  runJoinFlow,
  useJoinSessionAuth,
} from "./index";
import JoinPageModule from "./JoinPage";
import * as resolveModule from "./lib/resolve-cloud-connection";
import * as runJoinFlowModule from "./lib/run-join-flow";
import * as useJoinSessionModule from "./lib/use-join-session";
import * as registerModule from "./register";

const CLOUD_API_BASE = "https://api.eliza.app";
const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const PERSONAL_BASE = `${CLOUD_API_BASE}/api/v1/eliza/agents/personal%3A00000000-0000-5000-8000-000000000001`;
// Obviously-fake, low-entropy stand-in for the opaque Steward session JWT
// (a realistic random UUID here trips the gitleaks generic-api-key rule).
const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";

function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: string) =>
    btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `hdr.${encode(JSON.stringify(claims))}.sig`;
}

interface JoinFlowHarness {
  client: JoinFlowClient;
  effects: JoinFlowEffects;
  requested: {
    cloudApiBase: string;
    authToken: string;
    signal?: AbortSignal;
  }[];
  baseUrlCalls: (string | null)[];
  tokenCalls: (string | null)[];
  savedServers: Parameters<JoinFlowEffects["savePersistedActiveServer"]>[0][];
  firstRunFlags: boolean[];
  progress: [string, string?][];
}

function makeJoinFlowHarness(selected: JoinFlowResult): JoinFlowHarness {
  const harness: JoinFlowHarness = {
    client: {
      async getPersonalSharedEliza(options) {
        harness.requested.push({ ...options });
        return selected;
      },
      setBaseUrl(baseUrl) {
        harness.baseUrlCalls.push(baseUrl);
      },
      setToken(token) {
        harness.tokenCalls.push(token);
      },
    },
    effects: {
      savePersistedActiveServer(server) {
        harness.savedServers.push(server);
      },
      savePersistedFirstRunComplete(complete) {
        harness.firstRunFlags.push(complete);
      },
    },
    requested: [],
    baseUrlCalls: [],
    tokenCalls: [],
    savedServers: [],
    firstRunFlags: [],
    progress: [],
  };
  return harness;
}

afterEach(() => {
  cleanup();
  setBootConfig(DEFAULT_BOOT_CONFIG);
  window.localStorage.clear();
});

describe("join barrel wiring", () => {
  it("re-exports the real implementations, not copies", () => {
    expect(joinBarrel.JoinPage).toBe(JoinPageModule);
    expect(joinBarrel.resolveJoinAuthToken).toBe(
      resolveModule.resolveJoinAuthToken,
    );
    expect(joinBarrel.resolveJoinCloudApiBase).toBe(
      resolveModule.resolveJoinCloudApiBase,
    );
    expect(joinBarrel.runJoinFlow).toBe(runJoinFlowModule.runJoinFlow);
    expect(joinBarrel.registerJoinFlow).toBe(registerModule.registerJoinFlow);
    expect(joinBarrel.JOIN_ROUTE_PATH).toBe(registerModule.JOIN_ROUTE_PATH);
    expect(typeof joinBarrel.useJoinSessionAuth).toBe("function");
    expect(joinBarrel.useJoinSessionAuth).toBe(
      useJoinSessionModule.useJoinSessionAuth,
    );
  });

  it("exports the canonical join route path", () => {
    expect(JOIN_ROUTE_PATH).toBe("join");
  });
});

describe("registerJoinFlow", () => {
  it("registers authenticated join and get-started routes in the shared registry", () => {
    expect(getCloudRoute(JOIN_ROUTE_PATH)).toBeUndefined();

    registerJoinFlow();

    const joinRoute = getCloudRoute(JOIN_ROUTE_PATH);
    expect(joinRoute?.group).toBe("auth");
    expect(joinRoute?.public).toBeFalsy();
    expect(joinRoute?.element).toBeDefined();

    const getStartedRoute = getCloudRoute("get-started");
    expect(getStartedRoute?.group).toBe("auth");
    expect(getStartedRoute?.public).toBeFalsy();
    expect(getStartedRoute?.element).toBeDefined();
  });

  it("is idempotent — a second call leaves the registry untouched", () => {
    const before = listCloudRoutes().map((route) => route.path);

    registerJoinFlow();

    expect(listCloudRoutes().map((route) => route.path)).toEqual(before);
  });
});

describe("resolveJoinCloudApiBase through the barrel", () => {
  it("prefers the boot-configured direct-cloud origin, trimmed", () => {
    setBootConfig({
      branding: {},
      cloudApiBase: "  https://cloud.join.example  ",
    });
    expect(resolveJoinCloudApiBase()).toBe("https://cloud.join.example");
  });

  it("falls back to the public Eliza Cloud origin when unconfigured", () => {
    setBootConfig({ branding: {} });
    expect(resolveJoinCloudApiBase()).toBe(CLOUD_API_BASE);
  });
});

describe("resolveJoinAuthToken through the barrel", () => {
  it("returns the trimmed stored Steward session token", () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, `  ${TOKEN}  `);
    expect(resolveJoinAuthToken()).toBe(TOKEN);
  });

  it("reads as signed out when no usable token is stored", () => {
    expect(resolveJoinAuthToken()).toBeNull();

    window.localStorage.setItem(STEWARD_TOKEN_KEY, "   ");
    expect(resolveJoinAuthToken()).toBeNull();
  });
});

describe("runJoinFlow through the barrel", () => {
  it("connects, persists the Shared identity, and reports ordered progress", async () => {
    const h = makeJoinFlowHarness({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: PERSONAL_ID,
      agentName: "",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });

    const result = await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: TOKEN,
      onProgress: (status, detail) => h.progress.push([status, detail]),
    });

    expect(h.requested).toEqual([
      { cloudApiBase: CLOUD_API_BASE, authToken: TOKEN },
    ]);
    expect(h.progress).toEqual([
      ["connecting", "Opening your personal Eliza…"],
      ["connecting", "Connecting to Shared…"],
      ["connecting", "Finishing setup…"],
    ]);
    expect(h.baseUrlCalls).toEqual([PERSONAL_BASE]);
    expect(h.tokenCalls).toEqual([TOKEN]);
    expect(h.savedServers).toEqual([
      {
        id: `cloud:${PERSONAL_ID}`,
        kind: "cloud",
        label: "Eliza",
        apiBase: PERSONAL_BASE,
        accessToken: TOKEN,
        cloudRuntimeAgentId: PERSONAL_ID,
        cloudRuntime: "shared",
      },
    ]);
    expect(h.firstRunFlags).toEqual([true]);
    expect(result).toEqual({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: PERSONAL_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });
  });

  it("announces the Dedicated variant when the account runtime is dedicated", async () => {
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
    const h = makeJoinFlowHarness({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: dedicatedAgentId,
      agentName: "Work Eliza",
      apiBase: dedicatedBase,
      runtime: "dedicated",
    });

    await runJoinFlow({
      client: h.client,
      effects: h.effects,
      cloudApiBase: CLOUD_API_BASE,
      authToken: TOKEN,
      onProgress: (status, detail) => h.progress.push([status, detail]),
    });

    expect(h.progress[1]).toEqual([
      "connecting",
      "Connecting to your Dedicated agent…",
    ]);
    expect(h.savedServers[0]?.cloudRuntimeAgentId).toBe(dedicatedAgentId);
    expect(h.savedServers[0]?.cloudRuntime).toBe("dedicated");
    expect(h.savedServers[0]?.label).toBe("Work Eliza");
  });

  it("rejects a blank personal id without touching the client or persistence", async () => {
    const h = makeJoinFlowHarness({
      personalElizaId: "",
      agentId: "",
      activeAgentId: PERSONAL_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: TOKEN,
      }),
    ).rejects.toThrow("Cloud did not return a personal Eliza to connect to.");

    expect(h.baseUrlCalls).toEqual([]);
    expect(h.savedServers).toEqual([]);
    expect(h.firstRunFlags).toEqual([]);
  });

  it("rejects an agent id that does not match the personal id", async () => {
    const h = makeJoinFlowHarness({
      personalElizaId: PERSONAL_ID,
      agentId: "00000000-0000-4000-8000-000000000099",
      activeAgentId: PERSONAL_ID,
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: TOKEN,
      }),
    ).rejects.toThrow("Cloud did not return a personal Eliza to connect to.");

    expect(h.baseUrlCalls).toEqual([]);
    expect(h.savedServers).toEqual([]);
    expect(h.firstRunFlags).toEqual([]);
  });

  it("rejects a payload with no active agent id", async () => {
    const h = makeJoinFlowHarness({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: "",
      agentName: "Eliza",
      apiBase: PERSONAL_BASE,
      runtime: "shared",
    });

    await expect(
      runJoinFlow({
        client: h.client,
        effects: h.effects,
        cloudApiBase: CLOUD_API_BASE,
        authToken: TOKEN,
      }),
    ).rejects.toThrow("Cloud did not return a personal Eliza to connect to.");

    expect(h.baseUrlCalls).toEqual([]);
    expect(h.savedServers).toEqual([]);
    expect(h.firstRunFlags).toEqual([]);
  });
});

describe("useJoinSessionAuth through the barrel", () => {
  it("reports settled and unauthenticated with no provider and no stored token", () => {
    const { result } = renderHook(() => useJoinSessionAuth());
    expect(result.current).toEqual({ ready: true, authenticated: false });
  });

  it("authenticates from a live locally stored Steward session", () => {
    window.localStorage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    const { result } = renderHook(() => useJoinSessionAuth());
    expect(result.current).toEqual({ ready: true, authenticated: true });
  });

  it("treats an expired stored session as signed out", () => {
    window.localStorage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    );
    const { result } = renderHook(() => useJoinSessionAuth());
    expect(result.current.authenticated).toBe(false);
  });

  it("treats a malformed stored token as signed out", () => {
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "not-a-jwt");
    const { result } = renderHook(() => useJoinSessionAuth());
    expect(result.current.authenticated).toBe(false);
  });

  it("re-reads storage when the steward-token-sync event fires", async () => {
    const { result } = renderHook(() => useJoinSessionAuth());
    expect(result.current.authenticated).toBe(false);

    window.localStorage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    );
    act(() => {
      window.dispatchEvent(new Event("steward-token-sync"));
    });

    await waitFor(() => {
      expect(result.current.authenticated).toBe(true);
    });
  });
});
