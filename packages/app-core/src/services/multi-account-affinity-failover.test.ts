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
 * The only synthetic element is the token *string* (a second real subscription
 * is a human OAuth step — covered by coding-account-bridge.live.test.ts under
 * ORCHESTRATOR_LIVE_MULTI_ACCOUNT). Store, pool, bridge, affinity map, and the
 * `_pool-metadata.json` round-trip are the production code path. No secrets.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteAccount, saveAccount } from "@elizaos/auth/account-storage";
import type { AccountCredentialProvider } from "@elizaos/auth/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "./account-pool.js";
import { getCodingAgentSelectorBridge } from "./coding-account-bridge.js";

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
  saveAccount({
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
  });
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
  __resetDefaultAccountPoolForTests();
});

afterEach(() => {
  __resetDefaultAccountPoolForTests();
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
    __resetDefaultAccountPoolForTests();
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
    deleteAccount("anthropic-subscription", "gone");
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
    deleteAccount("anthropic-subscription", "stays");
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
