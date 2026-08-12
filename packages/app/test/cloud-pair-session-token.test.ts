/**
 * Focused coverage for cloud-pair session adoption in the app entrypoint.
 * Importing `main.tsx` boots the renderer, so the test executes only the
 * isolated helper source with mocks for its collaborators.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
  cloudPairTokenKeyForAgent,
  isCloudPairAgentId,
  isCloudPairLoopbackOrigin,
} from "@elizaos/shared/contracts";
import { describe, expect, it } from "vitest";

const MAIN_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "src", "main.tsx"),
  "utf8",
);

type Invocation = {
  key: string;
  value?: string;
};

const AGENT_ID = "55555555-5555-4555-8555-555555555555";

function extractApplyCloudPairSessionTokenSource(): string {
  const start = MAIN_SOURCE.indexOf("function applyCloudPairSessionToken()");
  const end = MAIN_SOURCE.indexOf(
    "/**\n * Adds `eliza-electrobun-frameless`",
    start,
  );

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return MAIN_SOURCE.slice(start, end)
    .replace(
      "function applyCloudPairSessionToken(): void",
      "function applyCloudPairSessionToken()",
    )
    .replace("let token: string | null = null;", "let token = null;")
    .replace(
      "let legacyToken: string | null = null;",
      "let legacyToken = null;",
    )
    .replace("let apiBase: string;", "let apiBase;")
    .replace("let agentId: string | null = null;", "let agentId = null;")
    .replace("let ownerHint: string | null = null;", "let ownerHint = null;");
}

function runCloudPairSessionTokenHelper({
  durableToken,
  sessionToken,
  shellSetItem,
  durableGetItem,
  legacyToken,
  activeServer,
  origin = `https://${AGENT_ID}.elizacloud.ai`,
  durableOwnerHint,
  sessionOwnerHint,
  bootApiBase,
  persistActiveServer = true,
}: {
  durableToken?: string | null;
  sessionToken?: string | null;
  shellSetItem?: (key: string, value: string) => void;
  durableGetItem?: (key: string) => string | null;
  legacyToken?: string | null;
  activeServer?: unknown;
  origin?: string;
  durableOwnerHint?: string | null;
  sessionOwnerHint?: string | null;
  bootApiBase?: string | null;
  persistActiveServer?: boolean;
}) {
  const calls = {
    durableReads: [] as Invocation[],
    sessionReads: [] as Invocation[],
    shellWrites: [] as Invocation[],
    rawWrites: [] as Invocation[],
    sessionRemovals: [] as Invocation[],
    tokens: [] as string[],
    activeServers: [] as unknown[],
    profiles: [] as unknown[],
  };
  const globalKey = "eliza:cloud-pair:api-token";
  const agentKey = cloudPairTokenKeyForAgent(AGENT_ID);
  let persistedActiveServer = activeServer ?? null;
  const windowMock = {
    location: { origin, pathname: "/" },
    localStorage: {
      getItem(storageKey: string) {
        calls.durableReads.push({ key: storageKey });
        if (durableGetItem) return durableGetItem(storageKey);
        if (storageKey === agentKey) return durableToken ?? null;
        if (storageKey === globalKey) return legacyToken ?? null;
        if (storageKey === CLOUD_PAIR_LOCAL_OWNER_HINT_KEY) {
          return durableOwnerHint ?? null;
        }
        return null;
      },
      setItem(storageKey: string, value: string) {
        calls.rawWrites.push({ key: storageKey, value });
        throw new Error("raw localStorage writer must not be used");
      },
    },
    sessionStorage: {
      getItem(storageKey: string) {
        calls.sessionReads.push({ key: storageKey });
        if (storageKey === agentKey) return sessionToken ?? null;
        if (storageKey === CLOUD_PAIR_LOCAL_OWNER_HINT_KEY) {
          return sessionOwnerHint ?? null;
        }
        return null;
      },
      removeItem(storageKey: string) {
        calls.sessionRemovals.push({ key: storageKey });
      },
    },
  };
  const shellLocalStorageMock = {
    setItem(storageKey: string, value: string) {
      calls.shellWrites.push({ key: storageKey, value });
      shellSetItem?.(storageKey, value);
    },
    removeItem(storageKey: string) {
      calls.shellWrites.push({ key: storageKey });
    },
  };
  const source = extractApplyCloudPairSessionTokenSource();
  const execute = new Function(
    "window",
    "client",
    "isDedicatedCloudAgentBase",
    "getBootConfig",
    "dedicatedCloudAgentIdFromBase",
    "createPersistedActiveServer",
    "savePersistedActiveServer",
    "upsertAndActivateAgentProfile",
    "shellLocalStorage",
    "cloudPairTokenKeyForAgent",
    "loadPersistedActiveServer",
    "resolveDedicatedAgentId",
    "isEmbedPath",
    "CLOUD_PAIR_LOCAL_OWNER_HINT_KEY",
    "isCloudPairAgentId",
    "isCloudPairLoopbackOrigin",
    `const CLOUD_PAIR_SESSION_TOKEN_KEY = ${JSON.stringify(globalKey)};
      ${source}
      applyCloudPairSessionToken();`,
  );

  execute(
    windowMock,
    { setToken: (token: string) => calls.tokens.push(token) },
    (apiBase: string | undefined) => {
      if (typeof apiBase !== "string") return false;
      try {
        return new URL(apiBase).hostname.endsWith(".elizacloud.ai");
      } catch {
        return false;
      }
    },
    () => ({
      apiBase:
        bootApiBase === undefined
          ? `https://${AGENT_ID}.elizacloud.ai`
          : (bootApiBase ?? undefined),
    }),
    (apiBase: string | undefined) =>
      apiBase?.includes(AGENT_ID) ? AGENT_ID : null,
    (activeServer: unknown) => activeServer,
    (nextActiveServer: unknown) => {
      calls.activeServers.push(nextActiveServer);
      if (persistActiveServer) persistedActiveServer = nextActiveServer;
    },
    (profile: unknown) => calls.profiles.push(profile),
    shellLocalStorageMock,
    cloudPairTokenKeyForAgent,
    () => persistedActiveServer as unknown,
    (server: { apiBase?: string; id?: string } | null) =>
      server?.id === `cloud:${AGENT_ID}` || server?.apiBase?.includes(AGENT_ID)
        ? AGENT_ID
        : null,
    () => false,
    CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
    isCloudPairAgentId,
    isCloudPairLoopbackOrigin,
  );

  return calls;
}

describe("cloud pair session token adoption", () => {
  it("uses the durable per-agent token first without consulting the legacy key", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      sessionToken: "session-token",
      legacyToken: "legacy-token",
    });

    expect(calls.durableReads).toEqual([
      { key: cloudPairTokenKeyForAgent(AGENT_ID) },
    ]);
    expect(calls.sessionReads).toEqual([]);
    expect(calls.tokens).toEqual(["durable-token"]);
    expect(calls.shellWrites).toEqual([]);
  });

  it("reads the per-agent key only — a token stored for another agent is never adopted", () => {
    // The legacy global key holds agent-A's bearer; the boot targets AGENT_ID
    // and there is no per-agent key for it. Without an active-server
    // record proving ownership, the foreign token must NOT be adopted.
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      legacyToken: "agent-a-token",
      activeServer: {
        kind: "cloud",
        id: "cloud:agent-a",
        apiBase: "https://agent-a.elizacloud.ai",
        accessToken: "agent-a-token",
      },
    });

    expect(calls.tokens).toEqual([]);
    expect(calls.activeServers).toEqual([]);
    expect(calls.profiles).toEqual([]);
  });

  it("migrates a legacy session token to the per-agent key when the active server proves ownership", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      sessionToken: null,
      legacyToken: "legacy-token",
      activeServer: {
        kind: "cloud",
        id: `cloud:${AGENT_ID}`,
        apiBase: `https://${AGENT_ID}.elizacloud.ai`,
        accessToken: "legacy-token",
      },
    });

    expect(calls.tokens).toEqual(["legacy-token"]);
    expect(calls.shellWrites).toEqual([
      { key: cloudPairTokenKeyForAgent(AGENT_ID), value: "legacy-token" },
      { key: "eliza:cloud-pair:api-token" },
    ]);
    expect(calls.activeServers).toHaveLength(1);
  });

  it("does not adopt a legacy global token when the active server belongs to a different agent", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      legacyToken: "other-agents-token",
      activeServer: {
        kind: "cloud",
        id: "cloud:agent-b",
        apiBase: "https://agent-b.elizacloud.ai",
        accessToken: "other-agents-token",
      },
    });

    expect(calls.tokens).toEqual([]);
    expect(calls.shellWrites).toEqual([]);
  });

  it("does not adopt a legacy global token when the active server token differs", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      legacyToken: "legacy-token",
      activeServer: {
        kind: "cloud",
        id: "cloud:agent-123",
        apiBase: "https://agent-123.elizacloud.ai",
        accessToken: "different-token",
      },
    });

    expect(calls.tokens).toEqual([]);
    expect(calls.shellWrites).toEqual([]);
  });

  it("still adopts the same-tab per-agent session token when best-effort durable persistence fails", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      sessionToken: "session-token",
      shellSetItem: () => {
        throw new Error("durable storage unavailable");
      },
    });

    expect(calls.tokens).toEqual(["session-token"]);
    expect(calls.activeServers).toHaveLength(1);
    expect(calls.profiles).toHaveLength(1);
  });

  it("falls back to the per-agent session token when durable reads fail", () => {
    const calls = runCloudPairSessionTokenHelper({
      sessionToken: "session-token",
      durableGetItem: () => {
        throw new Error("durable storage unavailable");
      },
    });

    expect(calls.tokens).toEqual(["session-token"]);
    expect(calls.shellWrites).toEqual([
      { key: cloudPairTokenKeyForAgent(AGENT_ID), value: "session-token" },
    ]);
  });

  it("adopts a scoped token on strict loopback only when the relay supplied its UUID owner", () => {
    const calls = runCloudPairSessionTokenHelper({
      origin: "http://127.0.0.1:43123",
      bootApiBase: null,
      durableToken: "local-agent-token",
      sessionOwnerHint: AGENT_ID,
      durableOwnerHint: "66666666-6666-4666-8666-666666666666",
    });

    expect(calls.tokens).toEqual(["local-agent-token"]);
    expect(calls.activeServers).toEqual([
      expect.objectContaining({
        id: `cloud:${AGENT_ID}`,
        apiBase: "http://127.0.0.1:43123",
        accessToken: "local-agent-token",
      }),
    ]);
    expect(calls.sessionRemovals).toEqual([
      { key: CLOUD_PAIR_LOCAL_OWNER_HINT_KEY },
    ]);
    expect(calls.shellWrites).toContainEqual({
      key: CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
    });
  });

  it("does not read a loopback bearer without a valid owner hint", () => {
    const calls = runCloudPairSessionTokenHelper({
      origin: "http://localhost:43123",
      bootApiBase: null,
      durableToken: "must-not-be-read",
      durableOwnerHint: "not-an-agent",
    });

    expect(calls.tokens).toEqual([]);
    expect(calls.durableReads).toEqual([
      { key: CLOUD_PAIR_LOCAL_OWNER_HINT_KEY },
    ]);
  });

  it("retains the loopback owner hint when durable session persistence fails", () => {
    const calls = runCloudPairSessionTokenHelper({
      origin: "http://127.0.0.1:43123",
      bootApiBase: null,
      durableToken: "local-agent-token",
      sessionOwnerHint: AGENT_ID,
      persistActiveServer: false,
    });

    expect(calls.tokens).toEqual(["local-agent-token"]);
    expect(calls.sessionRemovals).toEqual([]);
    expect(calls.shellWrites).not.toContainEqual({
      key: CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
    });
  });

  it("never uses a local owner hint from a non-loopback public origin", () => {
    const calls = runCloudPairSessionTokenHelper({
      origin: "https://attacker.example",
      bootApiBase: null,
      durableToken: "must-not-be-read",
      durableOwnerHint: AGENT_ID,
      sessionOwnerHint: AGENT_ID,
    });

    expect(calls.tokens).toEqual([]);
    expect(calls.durableReads).toEqual([]);
    expect(calls.sessionReads).toEqual([]);
  });

  it("keeps a trusted configured dedicated target ahead of loopback hints", () => {
    const calls = runCloudPairSessionTokenHelper({
      origin: "https://localhost:43123",
      durableToken: "configured-agent-token",
      durableOwnerHint: "66666666-6666-4666-8666-666666666666",
    });

    expect(calls.tokens).toEqual(["configured-agent-token"]);
    expect(calls.durableReads).toEqual([
      { key: cloudPairTokenKeyForAgent(AGENT_ID) },
    ]);
    expect(calls.sessionRemovals).toEqual([]);
  });
});
