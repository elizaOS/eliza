import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import type { AccountCredentialProvider } from "@elizaos/auth/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  configureDefaultAccountPoolSelection,
  getDefaultAccountPool,
} from "./account-pool.js";
import { readTodayCounters } from "./account-usage.js";
import {
  getCodingAgentSelectorBridge,
  isAuthFailure,
} from "./coding-account-bridge.js";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevCodexModel: string | undefined;
let prevCodingStrategy: string | undefined;

function writeAccount(
  providerId: AccountCredentialProvider,
  id: string,
  access: string,
  extra: { organizationId?: string; idToken?: string } = {},
): void {
  const { idToken, ...record } = extra;
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...record,
  });
}

async function setUsage(
  providerId: AccountCredentialProvider,
  id: string,
  sessionPct: number,
): Promise<void> {
  const pool = getDefaultAccountPool();
  const account = pool.list(providerId as never).find((a) => a.id === id);
  if (!account) throw new Error(`no account ${id}`);
  await pool.upsert({
    ...account,
    usage: { sessionPct, refreshedAt: Date.now() },
  });
}

async function setPriority(
  providerId: AccountCredentialProvider,
  id: string,
  priority: number,
): Promise<void> {
  const pool = getDefaultAccountPool();
  const account = pool.list(providerId as never).find((a) => a.id === id);
  if (!account) throw new Error(`no account ${id}`);
  await pool.upsert({ ...account, priority });
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevCodexModel = process.env.ELIZA_CODEX_MODEL;
  prevCodingStrategy = process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  delete process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  home = mkdtempSync(path.join(tmpdir(), "coding-acct-"));
  process.env.ELIZA_HOME = home;
  // account-usage counters live under resolveStateDir() (ELIZA_STATE_DIR), not
  // ELIZA_HOME — isolate both so the usage-delta test doesn't touch real state.
  process.env.ELIZA_STATE_DIR = home;
  configureDefaultAccountPoolSelection();
  __resetDefaultAccountPoolForTests();
});

afterEach(() => {
  __resetDefaultAccountPoolForTests();
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevCodexModel === undefined) delete process.env.ELIZA_CODEX_MODEL;
  else process.env.ELIZA_CODEX_MODEL = prevCodexModel;
  if (prevCodingStrategy === undefined) {
    delete process.env.ELIZA_CODING_ACCOUNT_STRATEGY;
  } else {
    process.env.ELIZA_CODING_ACCOUNT_STRATEGY = prevCodingStrategy;
  }
  configureDefaultAccountPoolSelection();
  rmSync(home, { recursive: true, force: true });
});

describe("coding-account-bridge", () => {
  it("selects the least-used Claude subscription and returns CLAUDE_CODE_OAUTH_TOKEN", async () => {
    writeAccount("anthropic-subscription", "busy", "sk-ant-oat-BUSY");
    writeAccount("anthropic-subscription", "idle", "sk-ant-oat-IDLE");
    getDefaultAccountPool();
    await setUsage("anthropic-subscription", "busy", 90);
    await setUsage("anthropic-subscription", "idle", 5);

    const bridge = getCodingAgentSelectorBridge();
    expect(bridge).not.toBeNull();
    const sel = await bridge?.select("claude", { strategy: "least-used" });
    expect(sel?.providerId).toBe("anthropic-subscription");
    expect(sel?.accountId).toBe("idle");
    expect(sel?.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-IDLE");
    expect(sel?.source).toBe("oauth");
  });

  it("honors config.accountStrategies so the app's strategy picker steers coding spawns", async () => {
    writeAccount("anthropic-subscription", "primary", "sk-ant-oat-PRIMARY");
    writeAccount("anthropic-subscription", "spare", "sk-ant-oat-SPARE");
    getDefaultAccountPool();
    // priority-strategy favors "primary"; least-used favors the idle "spare".
    await setPriority("anthropic-subscription", "primary", 0);
    await setPriority("anthropic-subscription", "spare", 1);
    await setUsage("anthropic-subscription", "primary", 90);
    await setUsage("anthropic-subscription", "spare", 5);
    const bridge = getCodingAgentSelectorBridge();

    // Unconfigured: least-used default.
    const unconfigured = await bridge?.select("claude");
    expect(unconfigured?.strategy).toBe("least-used");
    expect(unconfigured?.accountId).toBe("spare");

    // The picker writes config.accountStrategies — selection must follow it.
    configureDefaultAccountPoolSelection({
      accountStrategies: { "anthropic-subscription": "priority" },
    });
    const configured = await bridge?.select("claude");
    expect(configured?.strategy).toBe("priority");
    expect(configured?.accountId).toBe("primary");

    // An explicit caller strategy still overrides the configured one.
    const explicit = await bridge?.select("claude", {
      strategy: "least-used",
    });
    expect(explicit?.strategy).toBe("least-used");
    expect(explicit?.accountId).toBe("spare");

    // The env var stays a fallback: used when no config, beaten by config.
    configureDefaultAccountPoolSelection();
    process.env.ELIZA_CODING_ACCOUNT_STRATEGY = "priority";
    const envFallback = await bridge?.select("claude");
    expect(envFallback?.strategy).toBe("priority");
    expect(envFallback?.accountId).toBe("primary");
    configureDefaultAccountPoolSelection({
      accountStrategies: { "anthropic-subscription": "least-used" },
    });
    const configOverEnv = await bridge?.select("claude");
    expect(configOverEnv?.strategy).toBe("least-used");
    expect(configOverEnv?.accountId).toBe("spare");
  });

  it("materializes a per-account CODEX_HOME/auth.json for Codex (incl. id_token)", async () => {
    writeAccount("openai-codex", "codex-1", "codex-access-1", {
      organizationId: "acct_123",
      idToken: "codex-id-token-1",
    });
    const bridge = getDefaultAccountPool() && getCodingAgentSelectorBridge();
    const sel = await bridge?.select("codex");
    expect(sel?.providerId).toBe("openai-codex");
    const codexHome = sel?.envPatch.CODEX_HOME;
    expect(codexHome).toBeTruthy();
    const authJson = JSON.parse(
      readFileSync(path.join(codexHome as string, "auth.json"), "utf-8"),
    );
    expect(authJson.tokens.access_token).toBe("codex-access-1");
    expect(authJson.tokens.account_id).toBe("acct_123");
    expect(authJson.auth_mode).toBe("chatgpt");
    // id_token must be present or codex-acp fails "Authentication required".
    expect(authJson.tokens.id_token).toBe("codex-id-token-1");
    // A minimal config.toml with a model — without it codex-acp falls back to a
    // default model ChatGPT-account auth rejects. (Live-verified: with this the
    // codex sub-agent built a file.)
    const configToml = readFileSync(
      path.join(codexHome as string, "config.toml"),
      "utf-8",
    );
    expect(configToml).toMatch(/^model = ".+"/m);
  });

  it("uses a valid ELIZA_CODEX_MODEL but rejects a malformed one (TOML injection guard)", async () => {
    writeAccount("openai-codex", "cx", "cx-access", { organizationId: "a" });
    process.env.ELIZA_CODEX_MODEL = "gpt-5.1-codex";
    let sel = await (
      getDefaultAccountPool() && getCodingAgentSelectorBridge()
    )?.select("codex");
    let cfg = readFileSync(
      path.join(sel?.envPatch.CODEX_HOME as string, "config.toml"),
      "utf-8",
    );
    expect(cfg).toContain('model = "gpt-5.1-codex"');

    // A value with a quote/newline would break out of the TOML string — reject
    // it and fall back to a safe model (operator's ~/.codex model or the
    // compiled default), never the injected payload.
    process.env.ELIZA_CODEX_MODEL = 'gpt"\n[evil]\nx = "1';
    __resetDefaultAccountPoolForTests();
    sel = await (
      getDefaultAccountPool() && getCodingAgentSelectorBridge()
    )?.select("codex");
    cfg = readFileSync(
      path.join(sel?.envPatch.CODEX_HOME as string, "config.toml"),
      "utf-8",
    );
    // Clean single model line, no injected table/keys.
    expect(cfg).toMatch(/^model = "[\w.:/-]+"\n$/);
    expect(cfg).not.toContain("[evil]");
  });

  it("rotates opencode across least-used cerebras-api accounts → CEREBRAS_API_KEY", async () => {
    writeAccount("cerebras-api", "cb-busy", "cb-key-busy");
    writeAccount("cerebras-api", "cb-idle", "cb-key-idle");
    getDefaultAccountPool();
    await setUsage("cerebras-api", "cb-busy", 88);
    await setUsage("cerebras-api", "cb-idle", 4);
    const sel = await getCodingAgentSelectorBridge()?.select("opencode", {
      strategy: "least-used",
    });
    expect(sel?.providerId).toBe("cerebras-api");
    expect(sel?.accountId).toBe("cb-idle");
    // buildOpencodeSpawnConfig reads CEREBRAS_API_KEY from the injected env.
    expect(sel?.envPatch.CEREBRAS_API_KEY).toBe("cb-key-idle");
    expect(sel?.source).toBe("api-key");
  });

  it("attributes recorded usage to the serving account (per-account delta)", async () => {
    writeAccount("anthropic-subscription", "acct", "sk-ant-oat-acct");
    const bridge = getDefaultAccountPool() && getCodingAgentSelectorBridge();
    expect(readTodayCounters("anthropic-subscription", "acct")).toEqual({
      calls: 0,
      tokens: 0,
      errors: 0,
    });
    // This is what OrchestratorTaskService.recordUsage calls when a turn ends.
    await bridge?.recordUsage("anthropic-subscription", "acct", {
      tokens: 1234,
      ok: true,
      model: "claude-opus",
    });
    await bridge?.recordUsage("anthropic-subscription", "acct", {
      tokens: 766,
      ok: true,
    });
    const counters = readTodayCounters("anthropic-subscription", "acct");
    expect(counters.calls).toBe(2);
    expect(counters.tokens).toBe(2000);
    expect(counters.errors).toBe(0);
    // lastUsedAt advanced — feeds least-used rotation + the dashboard.
    const acct = getDefaultAccountPool()
      .list("anthropic-subscription")
      .find((a) => a.id === "acct");
    expect(typeof acct?.lastUsedAt).toBe("number");
  });

  it("returns null when no accounts are linked (single-account fallback)", async () => {
    const bridge = getDefaultAccountPool() && getCodingAgentSelectorBridge();
    expect(await bridge?.select("claude")).toBeNull();
  });

  it("skips a rate-limited account on the next selection", async () => {
    writeAccount("anthropic-subscription", "a", "tok-a");
    writeAccount("anthropic-subscription", "b", "tok-b");
    const pool = getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    // Force "a" out: rate-limit it well into the future.
    await bridge?.markRateLimited(
      "anthropic-subscription",
      "a",
      Date.now() + 60 * 60 * 1000,
      "429",
    );
    const sel = await bridge?.select("claude", { strategy: "priority" });
    expect(sel?.accountId).toBe("b");
    expect(
      pool.list("anthropic-subscription").find((x) => x.id === "a")?.health,
    ).toBe("rate-limited");
  });

  it("describe() reports per-agent provider availability", async () => {
    writeAccount("anthropic-subscription", "c1", "t1");
    writeAccount("openai-codex", "x1", "t2");
    getDefaultAccountPool();
    const desc = getCodingAgentSelectorBridge()?.describe() ?? {};
    expect(
      desc.claude?.some(
        (p) => p.providerId === "anthropic-subscription" && p.enabled === 1,
      ),
    ).toBe(true);
    expect(
      desc.codex?.some(
        (p) => p.providerId === "openai-codex" && p.enabled === 1,
      ),
    ).toBe(true);
  });
});

describe("isAuthFailure (token-resolve triage)", () => {
  it("treats genuine auth failures + a missing credential as needs-reauth", () => {
    expect(isAuthFailure(undefined)).toBe(true); // no credential at all
    for (const m of [
      "401 Unauthorized",
      "403 Forbidden",
      "invalid_grant",
      "invalid token",
      "token expired",
      "refresh token revoked",
      "re-auth required",
    ]) {
      expect(isAuthFailure(new Error(m))).toBe(true);
    }
  });

  it("treats transient network/5xx errors as NOT auth (must not sideline account)", () => {
    for (const m of [
      "fetch failed",
      "ECONNRESET",
      "ETIMEDOUT",
      "socket hang up",
      "503 Service Unavailable",
      "502 Bad Gateway",
      "network timeout",
    ]) {
      expect(isAuthFailure(new Error(m))).toBe(false);
    }
  });
});
