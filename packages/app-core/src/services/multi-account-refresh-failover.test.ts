/**
 * Refresh-comfort + rate-limit-window hardening for the multi-account pool:
 *
 *  1. `adoptRotatedCodexTokens` — a Codex CLI self-refresh rotates the
 *     ONE-TIME-USE refresh token inside its per-account CODEX_HOME; the
 *     canonical record must adopt it or every later canonical refresh burns
 *     on the consumed token and the account is bricked into needs-reauth.
 *  2. `markRateLimited` honors the provider's own usage-window reset
 *     (`usage.resetsAt`) instead of a fixed heuristic cool-off.
 *  3. The bridge's `markNeedsReauth` verifies the credential (resolve +
 *     server-side usage probe) before evicting — an injected access token
 *     that merely aged out mid-session must not demand a manual re-login.
 *
 * Same real-path harness as multi-account-rotation.test.ts: real on-disk
 * credential store, real AccountPool, real bridge — no in-memory stubs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAccount, saveAccount } from "@elizaos/auth/account-storage";
import { writeJsonAtomicSync } from "@elizaos/auth/atomic-json";
import type { AccountCredentialProvider } from "@elizaos/auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "./account-pool.js";
import {
  adoptRotatedCodexTokens,
  getCodingAgentSelectorBridge,
} from "./coding-account-bridge.js";

let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;

const HOUR_MS = 60 * 60 * 1000;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Unsigned JWT with an exp claim, shaped like a ChatGPT access token. */
function fakeJwt(expMs: number): string {
  return `${b64url({ alg: "none" })}.${b64url({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function writeAccount(
  providerId: AccountCredentialProvider,
  id: string,
  credentials: {
    access: string;
    refresh: string;
    expires: number;
    idToken?: string;
  },
  extra: { organizationId?: string } = {},
): void {
  // NOTE: saveAccount stamps updatedAt = Date.now() itself; tests that need
  // "materialized copy newer than canonical" order their writes accordingly.
  saveAccount({
    id,
    providerId,
    label: id,
    source: "oauth",
    credentials,
    createdAt: Date.now() - 10 * HOUR_MS,
    updatedAt: Date.now(),
    ...(extra.organizationId ? { organizationId: extra.organizationId } : {}),
  });
}

/** Write the per-account CODEX_HOME auth.json the way a Codex CLI would. */
function writeMaterializedCodexAuth(
  accountId: string,
  tokens: { access_token: string; refresh_token: string; id_token?: string },
  lastRefreshMs: number,
): void {
  const dir = path.join(home, "auth", "_codex-home", accountId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(path.join(dir, "auth.json"), {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens,
    last_refresh: new Date(lastRefreshMs).toISOString(),
  });
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  home = mkdtempSync(path.join(tmpdir(), "multi-acct-refresh-"));
  process.env.ELIZA_HOME = home;
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
  vi.unstubAllGlobals();
});

describe("adoptRotatedCodexTokens (CLI self-refresh sync-back)", () => {
  it("adopts a rotated refresh token (+ access, id_token, JWT expiry) into the canonical record", async () => {
    // saveAccount stamps updatedAt itself, so order the writes the way the
    // real flow does: canonical login first, CLI refresh afterwards.
    writeAccount(
      "openai-codex",
      "codex-work",
      {
        access: "old-access",
        refresh: "rt-consumed",
        expires: Date.now() - HOUR_MS, // canonical looks expired
        idToken: "id-old",
      },
      { organizationId: "acct_W" },
    );
    await new Promise((r) => setTimeout(r, 10));
    const rotatedAccess = fakeJwt(Date.now() + 3 * HOUR_MS);
    writeMaterializedCodexAuth(
      "codex-work",
      {
        access_token: rotatedAccess,
        refresh_token: "rt-rotated",
        id_token: "id-new",
      },
      Date.now(), // CLI refreshed AFTER the canonical write
    );

    const adopted = await adoptRotatedCodexTokens("codex-work");
    expect(adopted).toBe(true);

    const record = loadAccount("openai-codex", "codex-work");
    expect(record?.credentials.refresh).toBe("rt-rotated");
    expect(record?.credentials.access).toBe(rotatedAccess);
    expect(record?.credentials.idToken).toBe("id-new");
    // Expiry decoded from the JWT exp claim.
    expect(record?.credentials.expires).toBeGreaterThan(
      Date.now() + 2 * HOUR_MS,
    );
    // organizationId (the ChatGPT account_id) survives adoption.
    expect(record?.organizationId).toBe("acct_W");
  });

  it("no-ops when the CLI never rotated (same refresh token)", async () => {
    writeAccount("openai-codex", "codex-work", {
      access: "same-access",
      refresh: "rt-same",
      expires: Date.now() + HOUR_MS,
    });
    writeMaterializedCodexAuth(
      "codex-work",
      { access_token: "same-access", refresh_token: "rt-same" },
      Date.now(),
    );
    expect(await adoptRotatedCodexTokens("codex-work")).toBe(false);
  });

  it("refuses to clobber a FRESHER canonical login with a stale materialized copy", async () => {
    // The user re-linked via OAuth after the old session ran: canonical is
    // newer than the materialized copy and must win.
    writeAccount("openai-codex", "codex-work", {
      access: "fresh-login-access",
      refresh: "rt-fresh-login",
      expires: Date.now() + 8 * HOUR_MS,
    });
    writeMaterializedCodexAuth(
      "codex-work",
      { access_token: "stale", refresh_token: "rt-stale-session" },
      Date.now() - 5 * HOUR_MS,
    );

    expect(await adoptRotatedCodexTokens("codex-work")).toBe(false);
    const record = loadAccount("openai-codex", "codex-work");
    expect(record?.credentials.refresh).toBe("rt-fresh-login");
  });

  it("no-ops when there is no materialized CODEX_HOME or it is corrupt", async () => {
    writeAccount("openai-codex", "codex-work", {
      access: "a",
      refresh: "r",
      expires: Date.now() + HOUR_MS,
    });
    expect(await adoptRotatedCodexTokens("codex-work")).toBe(false);
  });

  it("bridge.select heals the canonical record BEFORE resolving, so a CLI-rotated account still spawns", async () => {
    // Canonical: expired access + consumed refresh token. Without adoption,
    // select would try a network refresh with the burned token and fail.
    // fetch is stubbed to reject so any refresh attempt fails loudly instead
    // of hitting the real OAuth endpoint.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
    writeAccount(
      "openai-codex",
      "codex-work",
      {
        access: "old-access",
        refresh: "rt-consumed",
        expires: Date.now() - HOUR_MS,
        idToken: "id-old",
      },
      { organizationId: "acct_W" },
    );
    await new Promise((r) => setTimeout(r, 10));
    const rotatedAccess = fakeJwt(Date.now() + 3 * HOUR_MS);
    writeMaterializedCodexAuth(
      "codex-work",
      { access_token: rotatedAccess, refresh_token: "rt-rotated" },
      Date.now(),
    );

    getDefaultAccountPool(); // installs the bridge
    const bridge = getCodingAgentSelectorBridge();
    expect(bridge).not.toBeNull();
    const selection = await bridge?.select("codex");

    expect(selection?.accountId).toBe("codex-work");
    // The spawn env points at a CODEX_HOME whose auth.json now carries the
    // adopted (rotated) tokens.
    const codexHome = selection?.envPatch.CODEX_HOME ?? "";
    const authJson = JSON.parse(
      readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
    ) as { tokens: { access_token: string; refresh_token: string } };
    expect(authJson.tokens.access_token).toBe(rotatedAccess);
    expect(authJson.tokens.refresh_token).toBe("rt-rotated");
    // Canonical record healed.
    expect(loadAccount("openai-codex", "codex-work")?.credentials.refresh).toBe(
      "rt-rotated",
    );
  });
});

describe("markRateLimited honors the provider's usage-window reset", () => {
  it("uses usage.resetsAt (future) over the caller's heuristic cool-off", async () => {
    writeAccount("anthropic-subscription", "claude-work", {
      access: "a",
      refresh: "r",
      expires: Date.now() + HOUR_MS,
    });
    const pool = getDefaultAccountPool();
    const resetsAt = Date.now() + 5 * HOUR_MS;
    const account = pool.list("anthropic-subscription")[0];
    expect(account).toBeDefined();
    await pool.upsert({
      ...(account as NonNullable<typeof account>),
      usage: { refreshedAt: Date.now(), sessionPct: 100, resetsAt },
    });

    await pool.markRateLimited("claude-work", Date.now() + 60_000, "429", {
      providerId: "anthropic-subscription",
    });

    const marked = pool.get("claude-work", "anthropic-subscription");
    expect(marked?.health).toBe("rate-limited");
    expect(marked?.healthDetail?.until).toBe(resetsAt);
  });

  it("falls back to the caller's cool-off when resetsAt is missing or already past", async () => {
    writeAccount("anthropic-subscription", "claude-work", {
      access: "a",
      refresh: "r",
      expires: Date.now() + HOUR_MS,
    });
    const pool = getDefaultAccountPool();
    const account = pool.list("anthropic-subscription")[0];
    await pool.upsert({
      ...(account as NonNullable<typeof account>),
      usage: {
        refreshedAt: Date.now(),
        sessionPct: 100,
        resetsAt: Date.now() - 60_000, // stale — window already reset
      },
    });

    const heuristic = Date.now() + 15 * 60_000;
    await pool.markRateLimited("claude-work", heuristic, "429", {
      providerId: "anthropic-subscription",
    });

    const marked = pool.get("claude-work", "anthropic-subscription");
    expect(marked?.healthDetail?.until).toBe(heuristic);
  });
});

describe("bridge.markNeedsReauth verifies before evicting", () => {
  it("keeps the account in rotation when the credential verifies server-side (injected token aged out mid-session)", async () => {
    writeAccount("anthropic-subscription", "claude-work", {
      access: "still-valid-access",
      refresh: "rt",
      expires: Date.now() + 8 * HOUR_MS,
    });
    // Usage probe succeeds → credential is genuinely alive. Anthropic ships
    // utilization on the 0..1 scale.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ five_hour_utilization: 0.42 }),
      })),
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    await bridge?.markNeedsReauth(
      "anthropic-subscription",
      "claude-work",
      "sub-agent session s-1 (claude)",
    );

    const pool = getDefaultAccountPool();
    const account = pool.get("claude-work", "anthropic-subscription");
    // Not evicted — the probe restored health + usage.
    expect(account?.health).toBe("ok");
    expect(account?.usage?.sessionPct).toBe(42);
  });

  it("marks needs-reauth when the credential genuinely fails to resolve (dead refresh token)", async () => {
    writeAccount("anthropic-subscription", "claude-work", {
      access: "expired-access",
      refresh: "rt-dead",
      expires: Date.now() - HOUR_MS,
    });
    // Refresh attempt → invalid_grant.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        text: async () => '{"error":"invalid_grant"}',
        json: async () => ({ error: "invalid_grant" }),
      })),
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    await bridge?.markNeedsReauth(
      "anthropic-subscription",
      "claude-work",
      "sub-agent session s-1 (claude)",
    );

    const pool = getDefaultAccountPool();
    expect(pool.get("claude-work", "anthropic-subscription")?.health).toBe(
      "needs-reauth",
    );
  });

  it("leaves rotation state alone on a transient verify failure (network blip)", async () => {
    writeAccount("anthropic-subscription", "claude-work", {
      access: "still-valid-access",
      refresh: "rt",
      expires: Date.now() + 8 * HOUR_MS,
    });
    // Usage probe hits a 500 — not auth-shaped.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "internal error",
        json: async () => ({}),
      })),
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    await bridge?.markNeedsReauth(
      "anthropic-subscription",
      "claude-work",
      "sub-agent session s-1 (claude)",
    );

    const pool = getDefaultAccountPool();
    // Neither evicted nor force-healed — left for the keep-alive sweep.
    expect(pool.get("claude-work", "anthropic-subscription")?.health).not.toBe(
      "needs-reauth",
    );
  });
  // #11033 regression: direct-API keys resolve offline from local storage with
  // a never-expires sentinel, so a successful getAccessToken proves nothing —
  // a cached-but-revoked key that 401'd a session must be probed against the
  // provider, not blindly kept in rotation.
  it("marks a REVOKED direct-API key needs-reauth (probe 401), not kept in rotation", async () => {
    writeAccount("anthropic-api", "ada-anthropic-api", {
      access: "sk-ant-revoked",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    });
    // The direct-key probe (GET /models) returns 401 → the stored key is dead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"type":"authentication_error"}}',
        json: async () => ({ error: { type: "authentication_error" } }),
      })),
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    await bridge?.markNeedsReauth(
      "anthropic-api",
      "ada-anthropic-api",
      "sub-agent session s-2 (claude)",
    );

    const pool = getDefaultAccountPool();
    expect(pool.get("ada-anthropic-api", "anthropic-api")?.health).toBe(
      "needs-reauth",
    );
  });

  it("keeps a still-valid direct-API key in rotation (probe 200)", async () => {
    writeAccount("anthropic-api", "ada-anthropic-api", {
      access: "sk-ant-good",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    await bridge?.markNeedsReauth(
      "anthropic-api",
      "ada-anthropic-api",
      "sub-agent session s-2 (claude)",
    );

    const pool = getDefaultAccountPool();
    expect(pool.get("ada-anthropic-api", "anthropic-api")?.health).not.toBe(
      "needs-reauth",
    );
  });

  it("leaves a direct-API key alone on an inconclusive probe (network blip, status 0)", async () => {
    writeAccount("anthropic-api", "ada-anthropic-api", {
      access: "sk-ant-good",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    });
    // A rejected fetch → probeDirectApiKey returns { ok:false, status:0 }.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();

    await bridge?.markNeedsReauth(
      "anthropic-api",
      "ada-anthropic-api",
      "sub-agent session s-2 (claude)",
    );

    const pool = getDefaultAccountPool();
    expect(pool.get("ada-anthropic-api", "anthropic-api")?.health).not.toBe(
      "needs-reauth",
    );
  });
});
