import type { LinkedAccountConfig } from "@elizaos/contracts";
import { getCodingAgentSelectorBridge } from "@elizaos/core/protocol";

/**
 * Session-affinity semantics under mid-session failover — the gap left open by
 * the sibling suites (#11032 lineage, QA umbrella #10722/#9950):
 *
 *   - `account-pool.test.ts` proves affinity's happy path (same sessionKey →
 *     same account) against in-memory stubs.
 *   - `multi-account-rotation.test.ts` proves rate-limit → sibling failover,
 *     but with fresh session keys — never what happens to an EXISTING pinned
 *     session when its account dies mid-run.
 *   - the orchestrator's `account-failover-respawn.test.ts` drives the router
 *     with a MOCKED bridge.
 *
 * This suite drives the REAL default pool + REAL coding-account bridge over a
 * REAL on-disk credential store (throwaway ELIZA_HOME) and asserts OUTCOMES
 * (which account's token serves the session) for:
 *
 *   1. mid-session rate-limit → the pinned session fails over to the sibling
 *      AND re-pins to it (continuity: later same-session selects stay there),
 *   2. the resolver-style `exclude` failover (plugin-anthropic's 429 retry),
 *   3. the affinity re-selection window (SESSION_AFFINITY_MAX_ATTEMPTS),
 *   4. all accounts rate-limited with future resets → honest null + healthy:0,
 *   5. rate-limit window elapse → re-admission of the original account,
 *   6. account deleted mid-session (credential + metadata) → stale affinity
 *      entry fails over instead of serving a ghost,
 *   7. needs-reauth eviction is affinity-proof (a pinned dead account is never
 *      served) and re-linking restores rotation.
 *
 * Generated token strings and loopback HTTP responses keep the fixtures private.
 * Store, pool, provider parsers, bridge, affinity map and `_pool-metadata.json`
 * round-trips use production code. Live subscriptions have their separate
 * coding-account-bridge.live.test.ts lane under ORCHESTRATOR_LIVE_MULTI_ACCOUNT.
 */

import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The default pool and the credential helpers read through a runtime storage
// policy, which resolves the vault master key. Inject one in-memory test key
// for that, and write this file's fixtures through the same runtime policy.
vi.mock("../vault/master-key.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../vault/master-key.js")>();
  const { randomBytes } = await import("node:crypto");
  const testKey = randomBytes(32);
  return { ...actual, loadDefaultMasterKeySync: () => Buffer.from(testKey) };
});
vi.mock("../auth/account-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auth/account-storage.js")>();
  return {
    ...actual,
    createIsolatedAccountStoragePolicy:
      actual.createRuntimeAccountStoragePolicy,
  };
});

import {
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  loadAccount,
  saveAccount,
} from "../auth/account-storage.js";
import {
  getAccessToken,
  getAccessTokenCredentialReceipt,
} from "../auth/credentials.js";
import type { AccountCredentialProvider } from "../auth/types.js";
import { AccountPool } from "./account-pool.js";

// Every suite here drives the real on-disk credential store; each storage-lock
// acquisition performs multiple fsyncs, which stretch from milliseconds to
// seconds apiece on saturated CI disks. Budget the whole file for that, not
// just the sweep-heavy blocks.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

import {
  getDefaultAccountPool,
  resetDefaultAccountPoolAfterCredentialReset,
  sweepAccountPoolKeepAlive,
} from "./index.js";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevStrategy: string | undefined;

/** Write a real credential record to the on-disk store (the OAuth flow's end state). */
function writeAccount(
  providerId: AccountCredentialProvider,
  id: string,
  access: string,
  createdAt: number,
): void {
  saveAccount(
    {
      id,
      providerId,
      label: id,
      source: "oauth",
      credentials: {
        access,
        refresh: `${access}-refresh`,
        expires: FAR_FUTURE,
      },
      createdAt,
      updatedAt: Date.now(),
    },
    createIsolatedAccountStoragePolicy(home),
  );
}

function bridgeOrThrow() {
  getDefaultAccountPool(); // installs the bridge
  const bridge = getCodingAgentSelectorBridge();
  if (!bridge) throw new Error("coding-agent bridge not installed");
  return bridge;
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevStrategy = process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  home = mkdtempSync(path.join(tmpdir(), "multi-acct-affinity-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  delete process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  resetDefaultAccountPoolAfterCredentialReset();
});

afterEach(() => {
  resetDefaultAccountPoolAfterCredentialReset();
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevStrategy === undefined)
    delete process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  else process.env.ELIZA_CODING_ACCOUNT_STRATEGY = prevStrategy;
  rmSync(home, { recursive: true, force: true });
});

describe("mid-session rate-limit failover preserves session semantics", () => {
  it("re-pins a pinned session to the sibling after its account rate-limits (respawn path: no exclude)", async () => {
    writeAccount("anthropic-subscription", "hot", "sk-ant-oat-HOT", 1_000);
    writeAccount("anthropic-subscription", "cool", "sk-ant-oat-COOL", 2_000);
    const bridge = bridgeOrThrow();

    // The session pins to "hot" (priority order: createdAt 1000 → priority 0).
    const first = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-1",
    });
    expect(first?.accountId).toBe("hot");
    expect(first?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-HOT");

    // Mid-session the spawned agent dies on a 429; the router marks the
    // serving account exactly like SubAgentRouter does, then respawns through
    // the NORMAL spawn path (same sessionKey, no exclude — the dead session's
    // account descriptor is dropped, selection is fresh).
    await bridge.markRateLimited(
      "anthropic-subscription",
      "hot",
      Date.now() + HOUR_MS,
      "429 rate limit exceeded",
    );

    const respawn = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-1",
    });
    // Served, not dropped — by the sibling, with the SIBLING's own token.
    expect(respawn?.accountId).toBe("cool");
    expect(respawn?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-COOL");

    // Continuity: the session is now pinned to the sibling — subsequent
    // same-session selects keep serving "cool", they don't ping-pong.
    const followUp = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-1",
    });
    expect(followUp?.accountId).toBe("cool");

    // A DIFFERENT session is unaffected by task-1's affinity: it also lands on
    // the only healthy account.
    const other = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-2",
    });
    expect(other?.accountId).toBe("cool");
  });

  it("honors the resolver-style exclude failover (429 retry: exclude the just-failed account)", async () => {
    writeAccount("anthropic-subscription", "a", "sk-ant-oat-A", 1_000);
    writeAccount("anthropic-subscription", "b", "sk-ant-oat-B", 2_000);
    const pool = getDefaultAccountPool();
    const bridge = bridgeOrThrow();

    const first = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "chat-1",
    });
    expect(first?.accountId).toBe("a");

    // plugin-anthropic's OAuth fetch does: markRateLimited(a) THEN re-select
    // with exclude:[a] — model both halves against the real pool.
    await bridge.markRateLimited(
      "anthropic-subscription",
      "a",
      Date.now() + HOUR_MS,
      "429 unified",
    );
    const retry = await pool.select({
      providerId: "anthropic-subscription",
      sessionKey: "chat-1",
      exclude: ["a"],
    });
    expect(retry?.id).toBe("b");

    // The pool state the dashboard reads reflects the mark.
    const marked = pool.get("a", "anthropic-subscription");
    expect(marked?.health).toBe("rate-limited");
    expect(marked?.healthDetail?.until).toBeGreaterThan(Date.now());
  });

  it("re-selects after the affinity attempts window and re-pins (SESSION_AFFINITY_MAX_ATTEMPTS)", async () => {
    writeAccount("openai-codex", "first", "codex-tok-1", 1_000);
    writeAccount("openai-codex", "second", "codex-tok-2", 2_000);
    const pool = getDefaultAccountPool();

    // Pin: attempts=1. Two cached hits: attempts→3. The 4th select falls
    // through to the strategy (round-robin) and re-pins with a fresh window.
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sel = await pool.select({
        providerId: "openai-codex",
        strategy: "round-robin",
        sessionKey: "sticky",
      });
      picks.push(sel?.id ?? "none");
    }
    // First three selects stay pinned; the 4th re-runs the strategy.
    expect(picks[0]).toBe(picks[1]);
    expect(picks[1]).toBe(picks[2]);
    expect(new Set(picks.slice(0, 3)).size).toBe(1);
    // The re-selection re-pins: the two following selects stick to picks[3].
    const repinned = await pool.select({
      providerId: "openai-codex",
      strategy: "round-robin",
      sessionKey: "sticky",
    });
    expect(repinned?.id).toBe(picks[3]);
  });
});

describe("pool exhaustion and recovery", () => {
  it("returns null + healthy:0 when every account is rate-limited with a future reset (the router's honest-failure gate)", async () => {
    writeAccount("anthropic-subscription", "one", "sk-ant-oat-1", 1_000);
    writeAccount("anthropic-subscription", "two", "sk-ant-oat-2", 2_000);
    const bridge = bridgeOrThrow();

    await bridge.markRateLimited(
      "anthropic-subscription",
      "one",
      Date.now() + HOUR_MS,
      "429",
    );
    await bridge.markRateLimited(
      "anthropic-subscription",
      "two",
      Date.now() + 2 * HOUR_MS,
      "429",
    );

    // No eligible account — the spawn request gets an honest null, and the
    // describe() view the SubAgentRouter uses to decide "no respawn, tell the
    // user" reports zero healthy accounts.
    await expect(
      bridge.select("claude", { sessionKey: "task-x" }),
    ).resolves.toBeNull();
    const claudeAvailability = bridge.describe().claude ?? [];
    const sub = claudeAvailability.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    expect(sub).toMatchObject({ total: 2, enabled: 2, healthy: 0 });
  });

  it("readmits an account once its rate-limit window elapses (state persisted through the real overlay)", async () => {
    writeAccount("anthropic-subscription", "solo", "sk-ant-oat-SOLO", 1_000);
    const pool = getDefaultAccountPool();
    const bridge = bridgeOrThrow();

    await bridge.markRateLimited(
      "anthropic-subscription",
      "solo",
      Date.now() + HOUR_MS,
      "429",
    );
    await expect(bridge.select("claude", {})).resolves.toBeNull();

    // Time passes: the persisted overlay now holds an elapsed reset. Write it
    // through the same real persistence path the runtime uses (upsert), then
    // prove selection through a FRESH pool that re-reads the overlay from disk
    // — i.e. the elapsed window survives a process restart and readmits.
    const account = pool.get("solo", "anthropic-subscription");
    expect(account?.health).toBe("rate-limited");
    await pool.upsert({
      ...(account as NonNullable<typeof account>),
      healthDetail: { until: Date.now() - 1_000, lastChecked: Date.now() },
    });
    resetDefaultAccountPoolAfterCredentialReset();
    const readmitted = await bridgeOrThrow().select("claude", {});
    expect(readmitted?.accountId).toBe("solo");
    expect(readmitted?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat-SOLO",
    );
  });
});

describe("account removed mid-session", () => {
  it("fails over a pinned session when its account is deleted (credential + pool metadata)", async () => {
    writeAccount("anthropic-subscription", "gone", "sk-ant-oat-GONE", 1_000);
    writeAccount("anthropic-subscription", "stays", "sk-ant-oat-STAYS", 2_000);
    const pool = getDefaultAccountPool();
    const bridge = bridgeOrThrow();

    const first = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-del",
    });
    expect(first?.accountId).toBe("gone");

    // Operator deletes the account in the dashboard mid-session — the DELETE
    // route removes the on-disk credential AND the pool metadata overlay.
    deleteAccount(
      "anthropic-subscription",
      "gone",
      createIsolatedAccountStoragePolicy(home),
    );
    await pool.deleteMetadata("anthropic-subscription", "gone");
    expect(
      existsSync(
        path.join(home, "auth", "anthropic-subscription", "gone.json"),
      ),
    ).toBe(false);

    // The stale affinity entry (pinned to the ghost) must not serve it — the
    // eligibility gate drops the deleted account, the session fails over.
    const failover = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-del",
    });
    expect(failover?.accountId).toBe("stays");
    expect(failover?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-STAYS");

    // Removing the LAST account leaves an honest empty pool, not a crash.
    deleteAccount(
      "anthropic-subscription",
      "stays",
      createIsolatedAccountStoragePolicy(home),
    );
    await pool.deleteMetadata("anthropic-subscription", "stays");
    await expect(
      bridge.select("claude", { sessionKey: "task-del" }),
    ).resolves.toBeNull();
    expect(pool.list("anthropic-subscription")).toHaveLength(0);
  });
});

describe("needs-reauth eviction is affinity-proof", () => {
  it("never serves a pinned needs-reauth account; re-linking restores it to rotation", async () => {
    writeAccount("anthropic-subscription", "stale", "sk-ant-oat-STALE", 1_000);
    writeAccount("anthropic-subscription", "fresh", "sk-ant-oat-FRESH", 2_000);
    const pool = getDefaultAccountPool();
    const bridge = bridgeOrThrow();

    const pinned = await bridge.select("claude", {
      strategy: "priority",
      sessionKey: "task-reauth",
    });
    expect(pinned?.accountId).toBe("stale");

    // The keep-alive sweep (or the bridge's verified eviction) flags the
    // account. Unlike rate-limited, needs-reauth has NO self-healing window —
    // the pinned session must fail over and stay off it.
    await pool.markNeedsReauth("stale", "invalid_grant", {
      providerId: "anthropic-subscription",
    });
    for (let i = 0; i < 3; i++) {
      const sel = await bridge.select("claude", {
        strategy: "priority",
        sessionKey: "task-reauth",
      });
      expect(sel?.accountId).toBe("fresh");
    }

    // Re-linking via OAuth (fresh credential write) + the health reset the
    // routes/sweep perform brings it back — and priority again prefers it.
    writeAccount("anthropic-subscription", "stale", "sk-ant-oat-RELINK", 1_000);
    await pool.markHealthy("stale", {
      providerId: "anthropic-subscription",
    });
    const back = await pool.select({
      providerId: "anthropic-subscription",
      strategy: "priority",
    });
    expect(back?.id).toBe("stale");
  });
});

it("does not probe or refresh a disabled subscription account", async () => {
  writeAccount("anthropic-subscription", "disabled", "synthetic-disabled", 1);
  const pool = getDefaultAccountPool();
  const account = pool.get("disabled", "anthropic-subscription");
  if (!account) throw new Error("Missing stored fixture account");
  await pool.upsert({ ...account, enabled: false });
  const providerFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValue(
      new Error("Disabled account must not contact its provider"),
    );
  expect(await sweepAccountPoolKeepAlive({ fetch: providerFetch })).toEqual({
    checked: 1,
    refreshed: 0,
    failed: 0,
  });
  expect(providerFetch).not.toHaveBeenCalled();
  expect(pool.get("disabled", "anthropic-subscription")?.enabled).toBe(false);
});

/** Actual provider HTTP with explicit release points for metadata races. */
async function withHeldProvider(
  work: (provider: {
    waitForRequests(count: number): Promise<void>;
    reply(index: number, status: number, body: unknown): void;
    requests: Array<{
      url: string;
      authorization: string | undefined;
      organizationId: string | undefined;
    }>;
  }) => Promise<void>,
): Promise<void> {
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    organizationId: string | undefined;
  }> = [];
  const responses: ServerResponse[] = [];
  const waiting: Array<{ count: number; resolve(): void }> = [];
  const originalFetch = globalThis.fetch;
  const server = createServer((request, response) => {
    requests.push({
      url: String(request.headers["x-fixture-provider-url"]),
      authorization: request.headers.authorization,
      organizationId: request.headers["chatgpt-account-id"] as
        | string
        | undefined,
    });
    responses.push(response);
    for (const waiter of waiting) {
      if (requests.length >= waiter.count) waiter.resolve();
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing provider address");
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    expect([
      "https://console.anthropic.com/v1/oauth/token",
      "https://api.anthropic.com/api/oauth/usage",
      "https://api.anthropic.com/api/oauth/profile",
      "https://auth.openai.com/oauth/token",
      "https://chatgpt.com/backend-api/wham/usage",
    ]).toContain(url);
    const headers = new Headers(init?.headers);
    headers.set("x-fixture-provider-url", url);
    return originalFetch(`http://127.0.0.1:${address.port}/`, {
      ...init,
      headers,
    });
  }) as typeof fetch;
  try {
    await work({
      requests,
      waitForRequests(count) {
        if (requests.length >= count) return Promise.resolve();
        return new Promise<void>((resolve) => waiting.push({ count, resolve }));
      },
      reply(index, status, body) {
        const response = responses[index];
        if (!response) throw new Error(`Missing provider response ${index}`);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seedHealthAccount(
  access = "old-fixture-token",
  expires = FAR_FUTURE,
) {
  saveAccount(
    {
      id: "health-owner",
      providerId: "anthropic-subscription",
      label: access,
      email: "fixture@example.test",
      source: "oauth",
      credentials: { access, refresh: "fixture-refresh", expires },
      createdAt: 1,
      updatedAt: Date.now(),
    },
    createIsolatedAccountStoragePolicy(home),
  );
  const pool = getDefaultAccountPool();
  const account = pool.get("health-owner", "anthropic-subscription");
  if (!account) throw new Error("Missing health account");
  await pool.upsert({
    ...account,
    label: access,
    usage: {
      sessionPct: 80,
      weeklyPct: 80,
      refreshedAt: 1,
      resetsAt: FAR_FUTURE,
    },
  });
  return pool;
}

it("refuses an old usage response after the account credential is replaced", async () => {
  const pool = await seedHealthAccount();
  await withHeldProvider(async (provider) => {
    const pending = pool.refreshUsage("health-owner", "old-fixture-token", {
      providerId: "anthropic-subscription",
    });
    await provider.waitForRequests(1);
    deleteAccount(
      "anthropic-subscription",
      "health-owner",
      createIsolatedAccountStoragePolicy(home),
    );
    await pool.deleteMetadata("anthropic-subscription", "health-owner");
    await seedHealthAccount("new-fixture-token");
    provider.reply(0, 200, {
      five_hour: { utilization: 1 },
      seven_day: { utilization: 1 },
    });
    await pending;
    expect(
      pool.get("health-owner", "anthropic-subscription")?.usage?.sessionPct,
    ).toBe(80);
    expect(pool.get("health-owner", "anthropic-subscription")?.label).toBe(
      "new-fixture-token",
    );
  });
});

it("keeps a replacement healthy when an older keepalive refresh is rejected", async () => {
  const pool = await seedHealthAccount("old-fixture-token", 1);
  await withHeldProvider(async (provider) => {
    const pending = sweepAccountPoolKeepAlive();
    await provider.waitForRequests(1);
    deleteAccount(
      "anthropic-subscription",
      "health-owner",
      createIsolatedAccountStoragePolicy(home),
    );
    await pool.deleteMetadata("anthropic-subscription", "health-owner");
    await seedHealthAccount("new-fixture-token");
    provider.reply(0, 400, { error: "invalid_grant" });
    expect(await pending).toEqual({ checked: 1, refreshed: 0, failed: 1 });
    expect(pool.get("health-owner", "anthropic-subscription")?.health).toBe(
      "ok",
    );
  });
});

it("refreshes usage with the exact newly rotated credential receipt", async () => {
  const pool = await seedHealthAccount("old-fixture-token", 1);
  await withHeldProvider(async (provider) => {
    const pending = sweepAccountPoolKeepAlive();
    await provider.waitForRequests(1);
    provider.reply(0, 200, {
      access_token: "rotated-fixture-token",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    await provider.waitForRequests(2);
    expect(provider.requests[1]?.authorization).toBe(
      "Bearer rotated-fixture-token",
    );
    provider.reply(1, 200, {
      five_hour: { utilization: 35 },
      seven_day: { utilization: 40 },
    });
    expect(await pending).toEqual({ checked: 1, refreshed: 1, failed: 0 });
    expect(
      pool.get("health-owner", "anthropic-subscription")?.usage?.sessionPct,
    ).toBe(35);
    expect(
      loadAccount(
        "anthropic-subscription",
        "health-owner",
        createIsolatedAccountStoragePolicy(home),
      )?.credentials.refresh,
    ).toBe("rotated-refresh");
  });
});

it("keeps the replacement token and Codex organization in one credential receipt", async () => {
  const policy = createIsolatedAccountStoragePolicy(home);
  const save = (access: string, organizationId: string, expires: number) =>
    saveAccount(
      {
        id: "codex-context",
        providerId: "openai-codex",
        label: "Codex context fixture",
        source: "oauth",
        organizationId,
        credentials: { access, refresh: "fixture-refresh", expires },
        createdAt: 1,
        updatedAt: Date.now(),
      },
      policy,
    );
  save("old-token", "old-organization", 1);
  const pool = getDefaultAccountPool();
  await withHeldProvider(async (provider) => {
    const pending = sweepAccountPoolKeepAlive();
    await provider.waitForRequests(1);
    deleteAccount("openai-codex", "codex-context", policy);
    await pool.deleteMetadata("openai-codex", "codex-context");
    save("replacement-token", "replacement-organization", FAR_FUTURE);
    const claims = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "old-organization",
        },
      }),
    ).toString("base64url");
    provider.reply(0, 200, {
      access_token: `e30.${claims}.fixture`,
      refresh_token: "discarded-rotation",
      expires_in: 3600,
    });
    await provider.waitForRequests(2);
    expect(provider.requests[1]).toMatchObject({
      authorization: "Bearer replacement-token",
      organizationId: "replacement-organization",
    });
    provider.reply(1, 200, {
      rate_limit: {
        primary_window: { used_percent: 7 },
        secondary_window: { used_percent: 8 },
      },
    });
    expect(await pending).toEqual({ checked: 1, refreshed: 1, failed: 0 });
    expect(pool.get("codex-context", "openai-codex")).toMatchObject({
      organizationId: "replacement-organization",
      usage: { sessionPct: 7, weeklyPct: 8 },
    });
    const outcome = await getAccessToken("openai-codex", "codex-context", {
      storagePolicy: policy,
      outcome: true,
    });
    expect(getAccessTokenCredentialReceipt(outcome)?.organizationId).toBe(
      "replacement-organization",
    );
    expect(Object.keys(outcome).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "ok",
      "refreshed",
    ]);
  });
});

it("keeps a newer health verdict while applying current-generation usage", async () => {
  const pool = await seedHealthAccount();
  await withHeldProvider(async (provider) => {
    const pending = pool.refreshUsage("health-owner", "old-fixture-token", {
      providerId: "anthropic-subscription",
    });
    await provider.waitForRequests(1);
    await pool.markNeedsReauth("health-owner", "newer verdict", {
      providerId: "anthropic-subscription",
    });
    provider.reply(0, 200, {
      five_hour: { utilization: 25 },
      seven_day: { utilization: 30 },
    });
    await pending;
    expect(pool.get("health-owner", "anthropic-subscription")).toMatchObject({
      health: "needs-reauth",
      healthDetail: { lastError: "newer verdict" },
      usage: { sessionPct: 25 },
    });
  });
});

it("refuses a stale default-pool metadata snapshot inside the storage lock", async () => {
  const pool = await seedHealthAccount();
  const stale = pool.get("health-owner", "anthropic-subscription");
  if (!stale) throw new Error("Missing original account");
  await seedHealthAccount("new-fixture-token");
  await pool.upsert({ ...stale, label: "stale metadata", health: "invalid" });
  expect(pool.get("health-owner", "anthropic-subscription")).toMatchObject({
    label: "new-fixture-token",
    health: "ok",
  });
});

it("keeps legacy unbranded pool writes and omitted generation guards compatible", async () => {
  const stored = new Map<string, LinkedAccountConfig>();
  const pool = new AccountPool({
    readAccounts: () => Object.fromEntries(stored),
    writeAccount: async (account) => {
      stored.set(account.id, account);
    },
  });
  await pool.upsert({
    id: "legacy",
    providerId: "anthropic-subscription",
    label: "Legacy",
    source: "oauth",
    enabled: true,
    priority: 0,
    createdAt: 1,
    health: "ok",
  });
  await pool.markNeedsReauth("legacy", "legacy verdict");
  expect(pool.get("legacy")?.health).toBe("needs-reauth");
  await pool.markHealthy("legacy", {
    expectedCredentialGeneration: "unverified-generation",
  });
  expect(pool.get("legacy")?.health).toBe("needs-reauth");
  await pool.markHealthy("legacy");
  expect(pool.get("legacy")?.health).toBe("ok");
});

it("keeps credential receipts outside the public outcome wire shape", async () => {
  await seedHealthAccount();
  const policy = createIsolatedAccountStoragePolicy(home);
  const record = loadAccount("anthropic-subscription", "health-owner", policy);
  const outcome = await getAccessToken(
    "anthropic-subscription",
    "health-owner",
    { storagePolicy: policy, outcome: true },
  );
  expect(getAccessTokenCredentialReceipt(outcome)).toEqual({
    provider: "anthropic-subscription",
    accountId: "health-owner",
    credentialGeneration: record?.credentialGeneration,
  });
  expect(Object.isFrozen(getAccessTokenCredentialReceipt(outcome))).toBe(true);
  expect(Object.keys(outcome).sort()).toEqual([
    "accessToken",
    "expiresAt",
    "ok",
    "refreshed",
  ]);
  expect(
    getAccessTokenCredentialReceipt(JSON.parse(JSON.stringify(outcome))),
  ).toBeUndefined();
});

const guardedHealthMutations = [
  {
    name: "rate-limited",
    apply: (
      pool: AccountPool,
      options: Parameters<AccountPool["markHealthy"]>[1],
    ) =>
      pool.markRateLimited(
        "health-owner",
        Date.now() + HOUR_MS,
        "late verdict",
        options,
      ),
  },
  {
    name: "unknown rate limit",
    apply: (
      pool: AccountPool,
      options: Parameters<AccountPool["markHealthy"]>[1],
    ) => pool.markRateLimitedUnknown("health-owner", "late verdict", options),
  },
  {
    name: "needs reauth",
    apply: (
      pool: AccountPool,
      options: Parameters<AccountPool["markHealthy"]>[1],
    ) => pool.markNeedsReauth("health-owner", "late verdict", options),
  },
  {
    name: "invalid",
    apply: (
      pool: AccountPool,
      options: Parameters<AccountPool["markHealthy"]>[1],
    ) => pool.markInvalid("health-owner", "late verdict", options),
  },
  {
    name: "healthy",
    apply: (
      pool: AccountPool,
      options: Parameters<AccountPool["markHealthy"]>[1],
    ) => pool.markHealthy("health-owner", options),
  },
  {
    name: "usage primed",
    apply: (
      pool: AccountPool,
      options: Parameters<AccountPool["markHealthy"]>[1],
    ) => pool.markUsagePrimed("health-owner", 42, options),
  },
];

it.each(guardedHealthMutations)(
  "fences stale $name mutations while preserving legacy omission",
  async ({ apply }) => {
    const pool = await seedHealthAccount();
    const outcome = await getAccessToken(
      "anthropic-subscription",
      "health-owner",
      { outcome: true },
    );
    const receipt = getAccessTokenCredentialReceipt(outcome);
    if (!receipt) throw new Error("Missing captured credential receipt");
    await seedHealthAccount("replacement-fixture-token");
    await pool.markNeedsReauth("health-owner", "replacement verdict", {
      providerId: "anthropic-subscription",
    });
    const before = pool.get("health-owner", "anthropic-subscription");
    await apply(pool, {
      providerId: "anthropic-subscription",
      expectedCredentialGeneration: receipt.credentialGeneration,
    });
    expect(pool.get("health-owner", "anthropic-subscription")).toEqual(before);
    await apply(pool, { providerId: "anthropic-subscription" });
    expect(pool.get("health-owner", "anthropic-subscription")).not.toEqual(
      before,
    );
  },
);

it("refuses stale explicit usage guards before HTTP and preserves omitted-guard callers", async () => {
  const pool = await seedHealthAccount();
  const outcome = await getAccessToken(
    "anthropic-subscription",
    "health-owner",
    { outcome: true },
  );
  const receipt = getAccessTokenCredentialReceipt(outcome);
  if (!receipt) throw new Error("Missing original receipt");
  await seedHealthAccount("replacement-fixture-token");
  await withHeldProvider(async (provider) => {
    expect(
      await pool.refreshUsage("health-owner", "old-fixture-token", {
        providerId: "anthropic-subscription",
        expectedCredentialGeneration: receipt.credentialGeneration,
      }),
    ).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
    const pending = pool.refreshUsage(
      "health-owner",
      "replacement-fixture-token",
      { providerId: "anthropic-subscription" },
    );
    await provider.waitForRequests(1);
    provider.reply(0, 200, {
      five_hour: { utilization: 30 },
      seven_day: { utilization: 35 },
    });
    expect(await pending).toBeUndefined();
    expect(
      pool.get("health-owner", "anthropic-subscription")?.usage?.sessionPct,
    ).toBe(30);
  });
});

it("keeps a replacement healthy after old coding-bridge credential verification", async () => {
  const pool = await seedHealthAccount("old-fixture-token", 1);
  const bridge = bridgeOrThrow();
  await withHeldProvider(async (provider) => {
    const pending = bridge.markNeedsReauth(
      "anthropic-subscription",
      "health-owner",
      "old session failure",
    );
    await provider.waitForRequests(1);
    deleteAccount(
      "anthropic-subscription",
      "health-owner",
      createIsolatedAccountStoragePolicy(home),
    );
    await pool.deleteMetadata("anthropic-subscription", "health-owner");
    await seedHealthAccount("replacement-fixture-token");
    provider.reply(0, 400, { error: "invalid_grant" });
    await pending;
    expect(pool.get("health-owner", "anthropic-subscription")?.health).toBe(
      "ok",
    );
  });
});

function runPoolHealthProcess(mode = "health") {
  const root = path.join(home, "process-fixture");
  const resultFile = path.join(home, "process-result.json");
  const fixture = fileURLToPath(
    new URL(
      "../../test/fixtures/pool-health-process-probe.ts",
      import.meta.url,
    ),
  );
  const child = spawnSync(
    process.execPath,
    ["--conditions=eliza-source", "--import", "tsx", fixture],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        VITEST: "",
        BUN_ENV: "",
        ELIZA_HOME: root,
        ELIZA_STATE_DIR: root,
        ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
        ELIZA_VAULT_PASSPHRASE: "isolated-pool-health-conformance",
        POOL_HEALTH_PROBE_ROOT: root,
        POOL_HEALTH_PROBE_MODE: mode,
        POOL_HEALTH_PROBE_RESULT: resultFile,
      },
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

it("merges usage with a same-generation health verdict from another process", () => {
  expect(runPoolHealthProcess()).toEqual({
    barrierEntered: true,
    health: "needs-reauth",
    detail: "independent process verdict",
    usage: 25,
  });
});

it("keeps an email installed by another process during the metadata lock wait", () => {
  expect(runPoolHealthProcess("email")).toEqual({
    barrierEntered: true,
    health: "ok",
    usage: 25,
    email: "current@example.test",
  });
});

it("does not count early subscription expiry as a usage refresh", async () => {
  const pool = await seedHealthAccount("old-fixture-token", 1);
  await withHeldProvider(async (provider) => {
    const pending = sweepAccountPoolKeepAlive();
    await provider.waitForRequests(1);
    const account = pool.get("health-owner", "anthropic-subscription");
    if (!account) throw new Error("Missing expiring account");
    await pool.upsert({ ...account, subscriptionEndsAt: Date.now() - 1 });
    provider.reply(0, 200, {
      access_token: "rotated-fixture-token",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    expect(await pending).toEqual({ checked: 1, refreshed: 0, failed: 0 });
    expect(provider.requests).toHaveLength(1);
    expect(pool.get("health-owner", "anthropic-subscription")?.health).toBe(
      "expired",
    );
  });
});

it.each(["before publication", "after publication"])(
  "does not acknowledge usage when metadata fails %s",
  async (stage) => {
    const pool = await seedHealthAccount();
    await withHeldProvider(async (provider) => {
      const pending = sweepAccountPoolKeepAlive();
      await provider.waitForRequests(1);
      const originalRename = fs.renameSync;
      const originalFsync = fs.fsyncSync;
      let published = false;
      let failed = false;
      const rename = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((from, to) => {
          if (String(to).endsWith("_pool-metadata.json")) {
            if (stage === "before publication" && !failed) {
              failed = true;
              throw new Error("fixture metadata publication failure");
            }
            originalRename(from, to);
            published = true;
            return;
          }
          originalRename(from, to);
        });
      const fsync = vi
        .spyOn(fs, "fsyncSync")
        .mockImplementation((descriptor) => {
          if (
            stage === "after publication" &&
            published &&
            !failed &&
            fs.fstatSync(descriptor).isDirectory()
          ) {
            failed = true;
            throw new Error("fixture metadata directory sync failure");
          }
          originalFsync(descriptor);
        });
      syncBuiltinESMExports();
      try {
        provider.reply(0, 200, {
          five_hour: { utilization: 25 },
          seven_day: { utilization: 30 },
        });
        expect(await pending).toEqual({ checked: 1, refreshed: 0, failed: 1 });
        expect(failed).toBe(true);
      } finally {
        rename.mockRestore();
        fsync.mockRestore();
        syncBuiltinESMExports();
      }
      expect(
        pool.get("health-owner", "anthropic-subscription")?.usage?.sessionPct,
      ).toBe(stage === "after publication" ? 25 : 80);
      expect(pool.get("health-owner", "anthropic-subscription")?.health).toBe(
        "ok",
      );
    });
  },
);

it("keeps an email that arrived while a profile backfill was pending", async () => {
  writeAccount("anthropic-subscription", "health-owner", "fixture-token", 1);
  const pool = getDefaultAccountPool();
  await withHeldProvider(async (provider) => {
    const pending = pool.refreshUsage("health-owner", "fixture-token", {
      providerId: "anthropic-subscription",
    });
    await provider.waitForRequests(1);
    provider.reply(0, 200, {
      five_hour: { utilization: 25 },
      seven_day: { utilization: 30 },
    });
    await provider.waitForRequests(2);
    const current = pool.get("health-owner", "anthropic-subscription");
    if (!current) throw new Error("Missing profile account");
    await pool.upsert({ ...current, email: "current@example.test" });
    provider.reply(1, 200, {
      account: { email: "older-profile@example.test" },
    });
    await pending;
    expect(pool.get("health-owner", "anthropic-subscription")?.email).toBe(
      "current@example.test",
    );
    expect(
      pool.get("health-owner", "anthropic-subscription")?.usage?.sessionPct,
    ).toBe(25);
  });
});

it("keeps concurrent usage when a health verdict waits for metadata ownership", () => {
  expect(runPoolHealthProcess("reverse")).toEqual({
    barrierEntered: true,
    health: "needs-reauth",
    detail: "parent health verdict",
    usage: 75,
  });
});

it("rechecks subscription extension before committing an expiry verdict", () => {
  expect(runPoolHealthProcess("expiry")).toEqual({
    barrierEntered: true,
    health: "ok",
    usage: 80,
    expiredCount: 0,
  });
});

it("uses the current Codex reset when a rate-limit verdict waits for metadata ownership", () => {
  const result = runPoolHealthProcess("cooldown");
  expect(result.barrierEntered).toBe(true);
  expect(result.health).toBe("rate-limited");
  expect(result.usage).toBe(75);
  expect(result.until).toBe(result.reset);
  expect(result.until).toBeGreaterThan(Date.now() + 3000000);
});
