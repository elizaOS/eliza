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
  origin = "https://agent-123.elizacloud.ai",
  pathname = "/",
  bootApiBase = "https://boot.elizacloud.ai",
  resolveAgentId = () => "agent-123",
  isEmbed = false,
}: {
  durableToken?: string | null;
  legacyToken?: string | null;
  shellSetItem?: (key: string, value: string) => void;
  durableGetItem?: (key: string) => string | null;
  origin?: string;
  pathname?: string;
  bootApiBase?: string | null;
  resolveAgentId?: () => string | null;
  isEmbed?: boolean;
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
    location: { origin, pathname },
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
    "isEmbedPath",
    `
      const CLOUD_PAIR_SESSION_TOKEN_KEY = ${JSON.stringify(key)};
      ${source}
      applyCloudPairSessionToken();
    `,
  );

  execute(
    windowMock,
    { setToken: (token: string) => calls.tokens.push(token) },
    // Mirrors the real isDedicatedCloudAgentBase: a dedicated agent lives on
    // its own `<agentId>.elizacloud.ai` subdomain, never on a control-plane
    // host (api/www/app/dev/elizacloud.ai or staging console).
    (apiBase: string | undefined) => {
      if (typeof apiBase !== "string" || !apiBase.includes(".elizacloud.ai")) {
        return false;
      }
      const host = new URL(apiBase).hostname;
      return (
        host.endsWith(".elizacloud.ai") &&
        ![
          "api.elizacloud.ai",
          "www.elizacloud.ai",
          "app.elizacloud.ai",
          "dev.elizacloud.ai",
          "elizacloud.ai",
          "staging.elizacloud.ai",
        ].includes(host)
      );
    },
    () => ({ apiBase: bootApiBase }),
    () => resolveAgentId(),
    (activeServer: unknown) => activeServer,
    (activeServer: unknown) => calls.activeServers.push(activeServer),
    (profile: unknown) => calls.profiles.push(profile),
    shellLocalStorageMock,
    (path: string) => isEmbed || path.startsWith("/embed"),
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

  it("does not read or stamp the token on an embedded third-party surface", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      legacyToken: "legacy-token",
      pathname: "/embed",
    });

    expect(calls.durableReads).toEqual([]);
    expect(calls.legacyReads).toEqual([]);
    expect(calls.tokens).toEqual([]);
    expect(calls.shellWrites).toEqual([]);
  });

  it("does not adopt the token on a non-dedicated origin even when a durable token exists", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      origin: "https://app.elizacloud.ai",
      bootApiBase: "https://elizacloud.ai",
    });

    expect(calls.durableReads).toEqual([]);
    expect(calls.tokens).toEqual([]);
    expect(calls.activeServers).toEqual([]);
    expect(calls.profiles).toEqual([]);
  });

  it("does not adopt when the boot target is not a dedicated cloud agent base", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      origin: "https://localhost:2138",
      bootApiBase: null,
    });

    expect(calls.durableReads).toEqual([]);
    expect(calls.tokens).toEqual([]);
    expect(calls.activeServers).toEqual([]);
  });

  it("does not adopt when the dedicated target has no resolvable agent id", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      resolveAgentId: () => null,
    });

    expect(calls.durableReads).toEqual([]);
    expect(calls.tokens).toEqual([]);
    expect(calls.activeServers).toEqual([]);
    expect(calls.profiles).toEqual([]);
  });

  it("still adopts through the boot config when the origin is non-dedicated but the target is dedicated", () => {
    const calls = runCloudPairSessionTokenHelper({
      durableToken: "durable-token",
      origin: "https://app.elizacloud.ai",
      bootApiBase: "https://agent-456.elizacloud.ai",
      resolveAgentId: () => "agent-456",
    });

    expect(calls.tokens).toEqual(["durable-token"]);
    expect(calls.activeServers).toHaveLength(1);
    expect(calls.profiles).toHaveLength(1);
  });
});
