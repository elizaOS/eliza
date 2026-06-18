import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/agent/auth/account-storage";
import type { AccountCredentialProvider } from "@elizaos/agent/auth/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "./account-pool.js";
import { readTodayCounters } from "./account-usage.js";
import { getCodingAgentSelectorBridge } from "./coding-account-bridge.js";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;

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

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  home = mkdtempSync(path.join(tmpdir(), "coding-acct-"));
  process.env.ELIZA_HOME = home;
  // account-usage counters live under resolveStateDir() (ELIZA_STATE_DIR), not
  // ELIZA_HOME — isolate both so the usage-delta test doesn't touch real state.
  process.env.ELIZA_STATE_DIR = home;
  __resetDefaultAccountPoolForTests();
});

afterEach(() => {
  __resetDefaultAccountPoolForTests();
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
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
