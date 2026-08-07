/**
 * Focused coverage for cloud-pair session adoption in the app entrypoint.
 * Importing `main.tsx` boots the renderer, so the test executes only the
 * isolated helper source with mocks for its collaborators.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAIN_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "src", "main.tsx"),
  "utf8",
);

type Invocation = {
  key: string;
  value?: string;
};

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
    );
}

function runCloudPairSessionTokenHelper({
  durableToken,
  sessionToken,
  shellSetItem,
  durableGetItem,
  legacyToken,
  activeServer,
}: {
  durableToken?: string | null;
  sessionToken?: string | null;
  shellSetItem?: (key: string, value: string) => void;
  durableGetItem?: (key: string) => string | null;
  legacyToken?: string | null;
  activeServer?: unknown;
}) {
  const calls = {
    durableReads: [] as Invocation[],
    sessionReads: [] as Invocation[],
    shellWrites: [] as Invocation[],
    rawWrites: [] as Invocation[],
    tokens: [] as string[],
    activeServers: [] as unknown[],
    profiles: [] as unknown[],
  };
  const agentId = "agent-123";
  const globalKey = "eliza:cloud-pair:api-token";
  const agentKey = `eliza:cloud-pair:api-token:${agentId}`;
  const windowMock = {
    location: { origin: `https://${agentId}.elizacloud.ai` },
    localStorage: {
      getItem(storageKey: string) {
        calls.durableReads.push({ key: storageKey });
        if (durableGetItem) return durableGetItem(storageKey);
        if (storageKey === agentKey) return durableToken ?? null;
        if (storageKey === globalKey) return legacyToken ?? null;
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
        return storageKey === agentKey ? (sessionToken ?? null) : null;
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
    `const CLOUD_PAIR_SESSION_TOKEN_KEY = ${JSON.stringify(globalKey)};
      ${source}
      applyCloudPairSessionToken();`,
  );

  execute(
    windowMock,
    { setToken: (token: string) => calls.tokens.push(token) },
    (apiBase: string | undefined) =>
      typeof apiBase === "string" && apiBase.includes(".elizacloud.ai"),
    () => ({ apiBase: "https://boot.elizacloud.ai" }),
    () => agentId,
    (activeServer: unknown) => activeServer,
    (activeServer: unknown) => calls.activeServers.push(activeServer),
    (profile: unknown) => calls.profiles.push(profile),
    shellLocalStorageMock,
    (id: string) => `eliza:cloud-pair:api-token:${id}`,
    () => (activeServer ?? null) as unknown,
    (server: { apiBase?: string } | null) =>
      server?.apiBase?.includes("agent-123") ? "agent-123" : null,
    () => false,
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
      { key: "eliza:cloud-pair:api-token:agent-123" },
    ]);
    expect(calls.sessionReads).toEqual([]);
    expect(calls.tokens).toEqual(["durable-token"]);
    expect(calls.shellWrites).toEqual([]);
  });

  it("reads the per-agent key only — a token stored for another agent is never adopted", () => {
    // The legacy global key holds agent-A's bearer; the boot targets agent-123
    // and there is no per-agent key for agent-123. Without an active-server
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
        id: "cloud:agent-123",
        apiBase: "https://agent-123.elizacloud.ai",
        accessToken: "legacy-token",
      },
    });

    expect(calls.tokens).toEqual(["legacy-token"]);
    expect(calls.shellWrites).toEqual([
      { key: "eliza:cloud-pair:api-token:agent-123", value: "legacy-token" },
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
      { key: "eliza:cloud-pair:api-token:agent-123", value: "session-token" },
    ]);
  });
});
