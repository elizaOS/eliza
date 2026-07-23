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
    .replace("let token: string | null = null;", "let token = null;");
}

function runCloudPairSessionTokenHelper({
  durableToken,
  legacyToken,
  shellSetItem,
  durableGetItem,
}: {
  durableToken?: string | null;
  legacyToken?: string | null;
  shellSetItem?: (key: string, value: string) => void;
  durableGetItem?: (key: string) => string | null;
}) {
  const calls = {
    durableReads: [] as Invocation[],
    legacyReads: [] as Invocation[],
    shellWrites: [] as Invocation[],
    rawWrites: [] as Invocation[],
    tokens: [] as string[],
    activeServers: [] as unknown[],
    profiles: [] as unknown[],
  };
  const key = "eliza:cloud-pair:api-token";
  const windowMock = {
    location: { origin: "https://agent-123.elizacloud.ai" },
    localStorage: {
      getItem(storageKey: string) {
        calls.durableReads.push({ key: storageKey });
        if (durableGetItem) return durableGetItem(storageKey);
        return storageKey === key ? (durableToken ?? null) : null;
      },
      setItem(storageKey: string, value: string) {
        calls.rawWrites.push({ key: storageKey, value });
        throw new Error("raw localStorage writer must not be used");
      },
    },
    sessionStorage: {
      getItem(storageKey: string) {
        calls.legacyReads.push({ key: storageKey });
        return storageKey === key ? (legacyToken ?? null) : null;
      },
    },
  };
  const shellLocalStorageMock = {
    setItem(storageKey: string, value: string) {
      calls.shellWrites.push({ key: storageKey, value });
      shellSetItem?.(storageKey, value);
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
    `
      const CLOUD_PAIR_SESSION_TOKEN_KEY = ${JSON.stringify(key)};
      ${source}
      applyCloudPairSessionToken();
    `,
  );

  execute(
    windowMock,
    { setToken: (token: string) => calls.tokens.push(token) },
    (apiBase: string | undefined) =>
      typeof apiBase === "string" && apiBase.includes(".elizacloud.ai"),
    () => ({ apiBase: "https://boot.elizacloud.ai" }),
    () => "agent-123",
    (activeServer: unknown) => activeServer,
    (activeServer: unknown) => calls.activeServers.push(activeServer),
    (profile: unknown) => calls.profiles.push(profile),
    shellLocalStorageMock,
  );

  return calls;
}

describe("cloud pair session token adoption", () => {
  it("uses the durable token first without consulting the legacy session token", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      legacyToken: "legacy-token",
    });

    expect(calls.durableReads).toEqual([{ key: "eliza:cloud-pair:api-token" }]);
    expect(calls.legacyReads).toEqual([]);
    expect(calls.tokens).toEqual(["durable-token"]);
    expect(calls.shellWrites).toEqual([]);
  });

  it("migrates a legacy session token through the privileged storage boundary", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      legacyToken: "legacy-token",
    });

    expect(calls.tokens).toEqual(["legacy-token"]);
    expect(calls.shellWrites).toEqual([
      { key: "eliza:cloud-pair:api-token", value: "legacy-token" },
    ]);
    expect(calls.rawWrites).toEqual([]);
  });

  it("still adopts the same-tab token when best-effort durable persistence fails", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: null,
      legacyToken: "legacy-token",
      shellSetItem: () => {
        throw new Error("durable storage unavailable");
      },
    });

    expect(calls.tokens).toEqual(["legacy-token"]);
    expect(calls.activeServers).toHaveLength(1);
    expect(calls.profiles).toHaveLength(1);
  });

  it("falls back to the legacy session token when durable reads fail", () => {
    const calls = runCloudPairSessionTokenHelper({
      legacyToken: "legacy-token",
      durableGetItem: () => {
        throw new Error("durable storage unavailable");
      },
    });

    expect(calls.tokens).toEqual(["legacy-token"]);
    expect(calls.shellWrites).toEqual([
      { key: "eliza:cloud-pair:api-token", value: "legacy-token" },
    ]);
  });

  // COLD-START CONTRACT (#16900-class relogin, PWA force-close):
  // Force-closing an installed iOS PWA wipes sessionStorage AND the in-memory
  // boot config; ONLY durable localStorage survives. On reopen, adoption must
  // re-establish a token-bearing cloud active-server from that lone durable
  // channel so startup restore has a bearer to probe /api/auth/me with — the
  // precondition that keeps the shell OFF the "Open this agent from Eliza
  // Cloud" interstitial. If this contract breaks, the cold-start restore path
  // silently 401s into the relogin wall on every launch.
  it("restores a token-bearing cloud active-server from durable storage alone (force-close cold start)", () => {
    const calls = runCloudPairSessionTokenHelper({
      // Simulate force-close: no legacy session token, no in-memory config —
      // only the durable localStorage mirror is left.
      durableToken: "durable-agent-key",
      legacyToken: null,
    });

    // The lone durable channel is consulted and adopted; the legacy session
    // channel is NOT needed (it is empty after a force-close anyway).
    expect(calls.durableReads).toEqual([{ key: "eliza:cloud-pair:api-token" }]);
    expect(calls.tokens).toEqual(["durable-agent-key"]);

    // Restore's precondition: exactly one cloud active-server, carrying the
    // adopted bearer. Without the accessToken here, startup restore hands the
    // client a null token, /api/auth/me 401s, and the interstitial renders.
    expect(calls.activeServers).toHaveLength(1);
    expect(calls.activeServers[0]).toMatchObject({
      kind: "cloud",
      accessToken: "durable-agent-key",
    });
    expect(calls.profiles).toHaveLength(1);
    expect(calls.profiles[0]).toMatchObject({
      kind: "cloud",
      accessToken: "durable-agent-key",
    });

    // A pure durable read must not re-write durable storage (no churn / no
    // legacy-migration write when the durable copy already exists).
    expect(calls.shellWrites).toEqual([]);
    expect(calls.rawWrites).toEqual([]);
  });
});
