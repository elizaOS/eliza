/**
 * Real-path multi-account E2E — issue #10696.
 *
 * Proves the crown-jewel claim "more than one Claude account AND more than one
 * Codex account are truly working" by driving the REAL `AccountPool` +
 * `coding-account-bridge` over an on-disk credential store — NOT the in-memory
 * stubs used by `account-pool.test.ts`. Each test materializes two accounts per
 * subscription tier under a throwaway `ELIZA_HOME`, then exercises selection,
 * strategy switching, priority reordering, rate-limit failover, and per-account
 * credential materialization, asserting on the bytes the spawned coding
 * subprocess would actually authenticate with.
 *
 * The only synthetic element is the token *string* (a real second Anthropic /
 * OpenAI subscription is a human-OAuth step, covered by
 * `coding-account-bridge.live.test.ts` under `ORCHESTRATOR_LIVE_MULTI_ACCOUNT`).
 * Everything else — the store, the pool, the bridge, the CODEX_HOME
 * materialization, the `_pool-metadata.json` round-trip — is the production code
 * path. Runs in CI with no secrets.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import type { AccountCredentialProvider } from "@elizaos/auth/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "./account-pool.js";
import { getCodingAgentSelectorBridge } from "./coding-account-bridge.js";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevStrategy: string | undefined;

/** Write a real credential record to the on-disk store (the OAuth flow's end state). */
function writeAccount(
  providerId: AccountCredentialProvider,
  id: string,
  access: string,
  extra: {
    organizationId?: string;
    idToken?: string;
    createdAt?: number;
  } = {},
): void {
  const { idToken, createdAt, ...record } = extra;
  saveAccount({
    id,
    providerId,
    label: id,
    source: "oauth",
    credentials: {
      access,
      refresh: `${access}-refresh`,
      expires: FAR_FUTURE,
      ...(idToken ? { idToken } : {}),
    },
    createdAt: createdAt ?? Date.now(),
    updatedAt: Date.now(),
    ...record,
  });
}

/** Mutate the pool-metadata overlay (priority/enabled) the way the HTTP PATCH route does. */
async function setMeta(
  providerId: AccountCredentialProvider,
  id: string,
  patch: { priority?: number; enabled?: boolean },
): Promise<void> {
  const pool = getDefaultAccountPool();
  const account = pool.list(providerId as never).find((a) => a.id === id);
  if (!account) throw new Error(`no account ${id}`);
  await pool.upsert({ ...account, ...patch });
}

function readCodexAuth(codexHome: string): {
  access_token: string;
  account_id?: string;
  id_token?: string;
} {
  const authJson = JSON.parse(
    readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
  );
  return authJson.tokens;
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevStrategy = process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  home = mkdtempSync(path.join(tmpdir(), "multi-acct-e2e-"));
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

describe("multi-account rotation E2E (#10696)", () => {
  it("surfaces TWO accounts per subscription tier (Claude + Codex) in list + describe", async () => {
    writeAccount("anthropic-subscription", "claude-personal", "sk-ant-oat-P");
    writeAccount("anthropic-subscription", "claude-work", "sk-ant-oat-W");
    writeAccount("openai-codex", "codex-personal", "codex-tok-P", {
      organizationId: "acct_P",
      idToken: "id-P",
    });
    writeAccount("openai-codex", "codex-work", "codex-tok-W", {
      organizationId: "acct_W",
      idToken: "id-W",
    });

    const pool = getDefaultAccountPool();
    expect(pool.list("anthropic-subscription")).toHaveLength(2);
    expect(pool.list("openai-codex")).toHaveLength(2);

    const desc = getCodingAgentSelectorBridge()?.describe() ?? {};
    const claudeSub = desc.claude?.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    const codexSub = desc.codex?.find((p) => p.providerId === "openai-codex");
    // Two connected, two enabled, two healthy — the "more than one of each" proof.
    expect(claudeSub).toMatchObject({ total: 2, enabled: 2, healthy: 2 });
    expect(codexSub).toMatchObject({ total: 2, enabled: 2, healthy: 2 });
  });

  it("round-robin alternates across the two Claude accounts (distinct tokens each turn)", async () => {
    writeAccount("anthropic-subscription", "a", "sk-ant-oat-A", {
      createdAt: 1_000,
    });
    writeAccount("anthropic-subscription", "b", "sk-ant-oat-B", {
      createdAt: 2_000,
    });
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sel = await bridge?.select("claude", { strategy: "round-robin" });
      picks.push(sel?.accountId ?? "none");
      // The token injected is always the *selected* account's own token.
      expect(sel?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe(
        sel?.accountId === "a" ? "sk-ant-oat-A" : "sk-ant-oat-B",
      );
    }
    // Alternation: consecutive picks differ, and both accounts are used.
    expect(picks[0]).not.toBe(picks[1]);
    expect(picks[1]).not.toBe(picks[2]);
    expect(picks[2]).not.toBe(picks[3]);
    expect(new Set(picks)).toEqual(new Set(["a", "b"]));
  });

  it("reordering priority changes which Claude account is served first", async () => {
    writeAccount("anthropic-subscription", "first", "sk-ant-oat-1", {
      createdAt: 1_000,
    });
    writeAccount("anthropic-subscription", "second", "sk-ant-oat-2", {
      createdAt: 2_000,
    });
    getDefaultAccountPool();
    await setMeta("anthropic-subscription", "first", { priority: 0 });
    await setMeta("anthropic-subscription", "second", { priority: 1 });
    const bridge = getCodingAgentSelectorBridge();

    const before = await bridge?.select("claude", { strategy: "priority" });
    expect(before?.accountId).toBe("first");

    // Operator drags "second" above "first" in AccountList (PATCH priority).
    await setMeta("anthropic-subscription", "first", { priority: 1 });
    await setMeta("anthropic-subscription", "second", { priority: 0 });

    const after = await bridge?.select("claude", { strategy: "priority" });
    expect(after?.accountId).toBe("second");
    expect(after?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-2");
  });

  it("rate-limiting the active Claude account hands off to its sibling — no dropped request", async () => {
    writeAccount("anthropic-subscription", "hot", "sk-ant-oat-HOT", {
      createdAt: 1_000,
    });
    writeAccount("anthropic-subscription", "cool", "sk-ant-oat-COOL", {
      createdAt: 2_000,
    });
    const pool = getDefaultAccountPool();
    await setMeta("anthropic-subscription", "hot", { priority: 0 });
    await setMeta("anthropic-subscription", "cool", { priority: 1 });
    const bridge = getCodingAgentSelectorBridge();

    // "hot" is the priority pick — until it 429s.
    expect(
      (await bridge?.select("claude", { strategy: "priority" }))?.accountId,
    ).toBe("hot");
    await bridge?.markRateLimited(
      "anthropic-subscription",
      "hot",
      Date.now() + 60 * 60 * 1000,
      "429",
    );

    // Next request is served, not dropped — by the healthy sibling.
    const failover = await bridge?.select("claude", { strategy: "priority" });
    expect(failover).not.toBeNull();
    expect(failover?.accountId).toBe("cool");
    expect(failover?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-COOL");
    expect(
      pool.list("anthropic-subscription").find((a) => a.id === "hot")?.health,
    ).toBe("rate-limited");
  });

  it("each Codex account materializes its OWN CODEX_HOME/auth.json — zero cross-account bleed", async () => {
    writeAccount("openai-codex", "cx-a", "codex-access-A", {
      organizationId: "acct_A",
      idToken: "id-A",
      createdAt: 1_000,
    });
    writeAccount("openai-codex", "cx-b", "codex-access-B", {
      organizationId: "acct_B",
      idToken: "id-B",
      createdAt: 2_000,
    });
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    const first = await bridge?.select("codex", { strategy: "priority" });
    const second = await bridge?.select("codex", {
      strategy: "priority",
      exclude: [first?.accountId ?? ""],
    });
    expect(first?.accountId).not.toBe(second?.accountId);

    const homeA = first?.envPatch.CODEX_HOME as string;
    const homeB = second?.envPatch.CODEX_HOME as string;
    // Distinct per-account CODEX_HOME dirs (keyed by accountId).
    expect(homeA).not.toBe(homeB);

    const map = new Map(
      [first, second].map((s) => [
        s?.accountId,
        readCodexAuth(s?.envPatch.CODEX_HOME as string),
      ]),
    );
    const authA = map.get("cx-a");
    const authB = map.get("cx-b");
    // Each dir holds ONLY its own account's token / account_id / id_token.
    expect(authA).toMatchObject({
      access_token: "codex-access-A",
      account_id: "acct_A",
      id_token: "id-A",
    });
    expect(authB).toMatchObject({
      access_token: "codex-access-B",
      account_id: "acct_B",
      id_token: "id-B",
    });
    // The bleed assertion: A's token never appears in B's materialized home.
    expect(authA?.access_token).not.toBe(authB?.access_token);
  });

  it("each Claude account injects its OWN CLAUDE_CODE_OAUTH_TOKEN (no bleed)", async () => {
    writeAccount("anthropic-subscription", "ca", "sk-ant-oat-CA", {
      createdAt: 1_000,
    });
    writeAccount("anthropic-subscription", "cb", "sk-ant-oat-CB", {
      createdAt: 2_000,
    });
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    const first = await bridge?.select("claude", { strategy: "priority" });
    const second = await bridge?.select("claude", {
      strategy: "priority",
      exclude: [first?.accountId ?? ""],
    });
    const tokenByAccount = new Map([
      [first?.accountId, first?.envPatch.CLAUDE_CODE_OAUTH_TOKEN],
      [second?.accountId, second?.envPatch.CLAUDE_CODE_OAUTH_TOKEN],
    ]);
    expect(tokenByAccount.get("ca")).toBe("sk-ant-oat-CA");
    expect(tokenByAccount.get("cb")).toBe("sk-ant-oat-CB");
    expect(first?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(
      second?.envPatch.CLAUDE_CODE_OAUTH_TOKEN,
    );
  });

  it("pool metadata (priority/enabled/usage) round-trips through _pool-metadata.json across a pool reset", async () => {
    writeAccount("openai-codex", "keep", "codex-keep", {
      organizationId: "acct_keep",
      createdAt: 1_000,
    });
    writeAccount("openai-codex", "off", "codex-off", {
      organizationId: "acct_off",
      createdAt: 2_000,
    });
    getDefaultAccountPool();
    await setMeta("openai-codex", "keep", { priority: 5, enabled: true });
    await setMeta("openai-codex", "off", { priority: 9, enabled: false });

    // Fresh pool re-reads the metadata overlay from disk (simulates a restart).
    __resetDefaultAccountPoolForTests();
    const reloaded = getDefaultAccountPool();
    const keep = reloaded.list("openai-codex").find((a) => a.id === "keep");
    const off = reloaded.list("openai-codex").find((a) => a.id === "off");
    expect(keep?.priority).toBe(5);
    expect(keep?.enabled).toBe(true);
    expect(off?.priority).toBe(9);
    expect(off?.enabled).toBe(false);

    // A disabled account is never selected; the enabled sibling always serves.
    const bridge = getCodingAgentSelectorBridge();
    for (let i = 0; i < 3; i++) {
      const sel = await bridge?.select("codex", { strategy: "round-robin" });
      expect(sel?.accountId).toBe("keep");
    }
  });

  it("re-enabling a disabled account restores it to rotation", async () => {
    writeAccount("anthropic-subscription", "x", "sk-ant-oat-X", {
      createdAt: 1_000,
    });
    writeAccount("anthropic-subscription", "y", "sk-ant-oat-Y", {
      createdAt: 2_000,
    });
    getDefaultAccountPool();
    await setMeta("anthropic-subscription", "y", { enabled: false });
    const bridge = getCodingAgentSelectorBridge();

    // Only "x" while "y" is disabled.
    for (let i = 0; i < 3; i++) {
      expect(
        (await bridge?.select("claude", { strategy: "round-robin" }))
          ?.accountId,
      ).toBe("x");
    }

    await setMeta("anthropic-subscription", "y", { enabled: true });
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const sel = await bridge?.select("claude", { strategy: "round-robin" });
      if (sel?.accountId) seen.add(sel.accountId);
    }
    expect(seen).toEqual(new Set(["x", "y"]));
  });
});
