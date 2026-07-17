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

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAccount, saveAccount } from "@elizaos/auth/account-storage";
import { writeJsonAtomicSync } from "@elizaos/auth/atomic-json";
import type { AccountCredentialProvider } from "@elizaos/auth/types";
import { logger } from "@elizaos/core";
import type { LinkedAccountConfig } from "@elizaos/shared/contracts/service-routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
  startAccountPoolKeepAlive,
  stopAccountPoolKeepAliveForTests,
  sweepAccountPoolKeepAlive,
} from "./account-pool.js";
import {
  adoptRotatedCodexTokens,
  getCodingAgentSelectorBridge,
} from "./coding-account-bridge.js";

let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevUsagePriming: string | undefined;

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

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for external writer: ${filePath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function startExternalCodexFileRotation(
  authPath: string,
  signalPath: string,
  payload: string,
): Promise<void> {
  const script = `
const fs = require("node:fs");
const authPath = process.argv[1];
const signalPath = process.argv[2];
const payload = process.argv[3];
const midpoint = Math.floor(payload.length / 2);
const fd = fs.openSync(authPath, "w", 0o600);
fs.writeSync(fd, payload.slice(0, midpoint));
fs.fsyncSync(fd);
fs.writeFileSync(signalPath, "writer-open");
setTimeout(() => {
  fs.writeSync(fd, payload.slice(midpoint));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}, 75);
`;
  const child = spawn(
    process.execPath,
    ["-e", script, authPath, signalPath, payload],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `external Codex writer exited code=${String(code)} signal=${String(signal)}: ${stderr}`,
        ),
      );
    });
  });
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevUsagePriming = process.env.ELIZA_ACCOUNT_POOL_USAGE_PRIMING;
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
  if (prevUsagePriming === undefined) {
    delete process.env.ELIZA_ACCOUNT_POOL_USAGE_PRIMING;
  } else {
    process.env.ELIZA_ACCOUNT_POOL_USAGE_PRIMING = prevUsagePriming;
  }
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

  it("no-ops when there is no materialized CODEX_HOME", async () => {
    writeAccount("openai-codex", "codex-work", {
      access: "a",
      refresh: "r",
      expires: Date.now() + HOUR_MS,
    });
    expect(await adoptRotatedCodexTokens("codex-work")).toBe(false);
  });

  it("fails closed before canonical refresh when the only Codex file generation is unreadable", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("getAccessToken must not run after adoption failure");
    });
    vi.stubGlobal("fetch", fetchSpy);
    writeAccount("openai-codex", "codex-work", {
      access: "expired-access",
      refresh: "rt-consumed",
      expires: Date.now() - HOUR_MS,
    });
    const codexHome = path.join(home, "auth", "_codex-home", "codex-work");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":');

    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    await expect(bridge?.select("codex")).rejects.toMatchObject({
      code: "CODEX_AUTH_FILE_UNSTABLE",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the background sweep from resolving a canonical token after adoption fails", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("getAccessToken must not run after adoption failure");
    });
    vi.stubGlobal("fetch", fetchSpy);
    writeAccount("openai-codex", "codex-work", {
      access: "expired-access",
      refresh: "rt-consumed",
      expires: Date.now() - HOUR_MS,
    });
    const codexHome = path.join(home, "auth", "_codex-home", "codex-work");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":');

    await expect(sweepAccountPoolKeepAlive()).rejects.toMatchObject({
      code: "CODEX_AUTH_FILE_UNSTABLE",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not brick a healthy Codex credential when usage parsing fails", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 10 },
              secondary_window: "unexpected-provider-shape",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    writeAccount(
      "openai-codex",
      "codex-work",
      {
        access: fakeJwt(Date.now() + HOUR_MS),
        refresh: "rt-valid",
        expires: Date.now() + HOUR_MS,
      },
      { organizationId: "org-work" },
    );

    const pool = getDefaultAccountPool();
    expect(pool.get("codex-work", "openai-codex")?.health).toBe("ok");

    await expect(sweepAccountPoolKeepAlive()).resolves.toEqual({
      checked: 1,
      refreshed: 0,
      failed: 1,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(pool.get("codex-work", "openai-codex")?.health).toBe("ok");
  });

  it.each([
    [401, "needs-reauth"],
    [429, "rate-limited"],
  ] as const)("classifies an HTTP %i usage rejection as %s", async (status, expectedHealth) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rejected", { status })),
    );
    writeAccount(
      "openai-codex",
      "codex-work",
      {
        access: fakeJwt(Date.now() + HOUR_MS),
        refresh: "rt-valid",
        expires: Date.now() + HOUR_MS,
      },
      { organizationId: "org-work" },
    );

    const pool = getDefaultAccountPool();
    await expect(sweepAccountPoolKeepAlive()).resolves.toEqual({
      checked: 1,
      refreshed: 0,
      failed: 1,
    });
    expect(pool.get("codex-work", "openai-codex")?.health).toBe(expectedHealth);
  });

  it("heals a flagged direct-API account after its stored credential resolves", async () => {
    writeAccount("anthropic-api", "direct-work", {
      access: "sk-ant-valid",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    });
    const pool = getDefaultAccountPool();
    await pool.markInvalid("direct-work", "earlier transient failure", {
      providerId: "anthropic-api",
    });
    expect(pool.get("direct-work", "anthropic-api")?.health).toBe("invalid");

    await expect(sweepAccountPoolKeepAlive()).resolves.toEqual({
      checked: 1,
      refreshed: 0,
      failed: 0,
    });
    expect(pool.get("direct-work", "anthropic-api")?.health).toBe("ok");
  });

  it("observes an adoption failure at the keep-alive timer boundary", async () => {
    writeAccount("openai-codex", "codex-work", {
      access: "expired-access",
      refresh: "rt-consumed",
      expires: Date.now() - HOUR_MS,
    });
    const codexHome = path.join(home, "auth", "_codex-home", "codex-work");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":');
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    try {
      startAccountPoolKeepAlive(60_000);
      await vi.waitFor(
        () => {
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("[AccountPool] keep-alive sweep failed:"),
          );
        },
        { timeout: 3_000, interval: 10 },
      );
      expect(
        getDefaultAccountPool().get("codex-work", "openai-codex")?.health,
      ).not.toBe("needs-reauth");
    } finally {
      stopAccountPoolKeepAliveForTests();
      errorSpy.mockRestore();
    }
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

  it("preserves and adopts a real external writer's rotated generation across concurrent selections", async () => {
    writeAccount(
      "openai-codex",
      "codex-work",
      {
        access: fakeJwt(Date.now() + HOUR_MS),
        refresh: "rt-initial",
        expires: Date.now() + HOUR_MS,
        idToken: "id-initial",
      },
      { organizationId: "acct_W" },
    );
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    const initial = await bridge?.select("codex");
    const selectedHome = initial?.envPatch.CODEX_HOME;
    expect(selectedHome).toBeTruthy();
    const canonicalBefore = loadAccount("openai-codex", "codex-work");
    expect(canonicalBefore).toBeTruthy();
    const rotationAt = new Date(
      Math.max(Date.now(), canonicalBefore?.updatedAt ?? 0) + 1_000,
    ).toISOString();
    const rotatedAccess = fakeJwt(Date.now() + 3 * HOUR_MS);
    const rotatedPayload = JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: rotatedAccess,
        refresh_token: "rt-external-rotated",
        id_token: "id-external-rotated",
        account_id: "acct_W",
      },
      last_refresh: rotationAt,
    });
    const authPath = path.join(selectedHome as string, "auth.json");
    const signalPath = path.join(home, "external-writer-open");
    const externalWriter = startExternalCodexFileRotation(
      authPath,
      signalPath,
      rotatedPayload,
    );
    await waitForFile(signalPath);

    const [first, second] = await Promise.all([
      bridge?.select("codex"),
      bridge?.select("codex"),
    ]);
    await externalWriter;

    expect(first?.envPatch.CODEX_HOME).toBe(selectedHome);
    expect(second?.envPatch.CODEX_HOME).toBe(selectedHome);
    // The bridge never rewrites a published auth generation, so the exact
    // external-process bytes and its real last_refresh survive materialization.
    expect(readFileSync(authPath, "utf-8")).toBe(rotatedPayload);
    const authAfter = JSON.parse(readFileSync(authPath, "utf-8")) as {
      last_refresh?: string;
      tokens?: { refresh_token?: string };
    };
    expect(authAfter.last_refresh).toBe(rotationAt);
    expect(authAfter.tokens?.refresh_token).toBe("rt-external-rotated");
    const canonicalAfter = loadAccount("openai-codex", "codex-work");
    expect(canonicalAfter?.credentials.access).toBe(rotatedAccess);
    expect(canonicalAfter?.credentials.refresh).toBe("rt-external-rotated");
    expect(canonicalAfter?.credentials.idToken).toBe("id-external-rotated");
  });

  it("fails closed when the required file-store config cannot be replaced", async () => {
    writeAccount("openai-codex", "codex-work", {
      access: fakeJwt(Date.now() + HOUR_MS),
      refresh: "rt-config",
      expires: Date.now() + HOUR_MS,
    });
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    const initial = await bridge?.select("codex");
    const selectedHome = initial?.envPatch.CODEX_HOME;
    expect(selectedHome).toBeTruthy();
    const configPath = path.join(selectedHome as string, "config.toml");
    rmSync(configPath);
    mkdirSync(configPath);

    await expect(bridge?.select("codex")).rejects.toMatchObject({
      code: "CODEX_CONFIG_MATERIALIZATION_FAILED",
    });
  });

  it("fails closed when the active Codex home cannot be published", async () => {
    writeAccount("openai-codex", "codex-work", {
      access: fakeJwt(Date.now() + HOUR_MS),
      refresh: "rt-pointer",
      expires: Date.now() + HOUR_MS,
    });
    getDefaultAccountPool();
    const bridge = getCodingAgentSelectorBridge();
    await bridge?.select("codex");
    const pointerPath = path.join(
      home,
      "auth",
      "_codex-home",
      "codex-work",
      "active-home",
    );
    rmSync(pointerPath);
    mkdirSync(pointerPath);

    await expect(bridge?.select("codex")).rejects.toMatchObject({
      code: "CODEX_ACTIVE_HOME_MATERIALIZATION_FAILED",
    });
  });
});

describe("Anthropic subscription usage priming", () => {
  const NOW = 1_900_000_000_000;
  const RESET_FUTURE = NOW + HOUR_MS;
  const RESET_PAST = NOW - 1_000;

  async function persistAnthropicMeta(
    patch: Partial<LinkedAccountConfig>,
  ): Promise<void> {
    const pool = getDefaultAccountPool();
    const account = pool.get("claude-work", "anthropic-subscription");
    expect(account).toBeTruthy();
    await pool.upsert({
      ...(account as NonNullable<typeof account>),
      email: "claude@example.test",
      ...patch,
    });
  }

  function writeAnthropicAccount(access = "secret-access-token"): void {
    writeAccount("anthropic-subscription", "claude-work", {
      access,
      refresh: "rt",
      expires: NOW + HOUR_MS,
    });
  }

  function usageResponse(resetsAt?: number): Response {
    return new Response(
      JSON.stringify({
        five_hour_utilization: 0.1,
        seven_day_utilization: 0.2,
        ...(resetsAt !== undefined ? { seven_day_resets_at: resetsAt } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("primes never-started Anthropic usage before canonical refresh", async () => {
    writeAnthropicAccount();
    await persistAnthropicMeta({});
    const calls: string[] = [];
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v1/messages")) return new Response("{}");
        return usageResponse(RESET_FUTURE);
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: async () => {},
        now: () => NOW,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(calls).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/api/oauth/usage",
    ]);
    const messagesInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(messagesInit.body as string)).toEqual({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    const headers = new Headers(messagesInit.headers);
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers.get("Authorization")).toBe("Bearer secret-access-token");
    expect(
      getDefaultAccountPool().get("claude-work", "anthropic-subscription")
        ?.lastPrimedAt,
    ).toBe(NOW);
  });

  it("skips missing-reset priming when the account was primed inside the debounce window", async () => {
    writeAnthropicAccount();
    await persistAnthropicMeta({ lastPrimedAt: NOW - HOUR_MS });
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith("/v1/messages")) {
          throw new Error("messages probe should be skipped");
        }
        return usageResponse(RESET_FUTURE);
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: async () => {},
        now: () => NOW,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://api.anthropic.com/api/oauth/usage",
    );
  });

  it("keeps usage priming off when ELIZA_ACCOUNT_POOL_USAGE_PRIMING=false", async () => {
    process.env.ELIZA_ACCOUNT_POOL_USAGE_PRIMING = "false";
    writeAnthropicAccount();
    await persistAnthropicMeta({});
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith("/v1/messages")) {
          throw new Error("messages probe should be disabled");
        }
        return usageResponse(RESET_FUTURE);
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: async () => {},
        now: () => NOW,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://api.anthropic.com/api/oauth/usage",
    );
  });

  it("primes at the reset boundary even when the debounce window is still fresh", async () => {
    writeAnthropicAccount();
    await persistAnthropicMeta({
      lastPrimedAt: NOW - HOUR_MS,
      usage: { refreshedAt: NOW - HOUR_MS, resetsAt: RESET_PAST },
    });
    const calls: string[] = [];
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v1/messages")) return new Response("{}");
        return usageResponse(RESET_FUTURE);
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: async () => {},
        now: () => NOW,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(calls[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(
      getDefaultAccountPool().get("claude-work", "anthropic-subscription")
        ?.lastPrimedAt,
    ).toBe(NOW);
  });

  it("does not repeat a probe already attempted for the crossed reset boundary", async () => {
    writeAnthropicAccount();
    await persistAnthropicMeta({
      lastPrimedAt: NOW - 500,
      usage: { refreshedAt: NOW - HOUR_MS, resetsAt: RESET_PAST },
    });
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith("/v1/messages")) {
          throw new Error("boundary probe should not repeat");
        }
        return usageResponse(RESET_FUTURE);
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: async () => {},
        now: () => NOW,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/api/oauth/usage");
  });

  it("refreshes immediately after the probe and retries once after delayed usage visibility", async () => {
    writeAnthropicAccount();
    await persistAnthropicMeta({});
    const sleepSpy = vi.fn(async () => {});
    const calls: string[] = [];
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/v1/messages")) return new Response("{}");
        const usageCalls = calls.filter((call) =>
          call.endsWith("/api/oauth/usage"),
        );
        return usageResponse(
          usageCalls.length === 1 ? undefined : RESET_FUTURE,
        );
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: sleepSpy,
        now: () => NOW,
        usagePrimingRetryDelayMs: 5,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(calls).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/api/oauth/usage",
      "https://api.anthropic.com/api/oauth/usage",
    ]);
    expect(sleepSpy).toHaveBeenCalledWith(5);
    expect(
      getDefaultAccountPool().get("claude-work", "anthropic-subscription")
        ?.usage?.resetsAt,
    ).toBe(RESET_FUTURE);
  });

  it("keeps probe failures soft and does not log OAuth material", async () => {
    writeAnthropicAccount("secret-access-token");
    await persistAnthropicMeta({});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith("/v1/messages")) {
          throw new Error("upstream echoed secret-access-token");
        }
        return usageResponse(RESET_FUTURE);
      },
    );

    await expect(
      sweepAccountPoolKeepAlive({
        fetch: fetchSpy as unknown as typeof fetch,
        sleep: async () => {},
        now: () => NOW,
      }),
    ).resolves.toEqual({ checked: 1, refreshed: 1, failed: 0 });

    expect(
      getDefaultAccountPool().get("claude-work", "anthropic-subscription")
        ?.health,
    ).toBe("ok");
    expect(
      getDefaultAccountPool().get("claude-work", "anthropic-subscription")
        ?.lastPrimedAt,
    ).toBe(NOW);
    const warned = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    warnSpy.mockRestore();
    expect(warned).not.toContain("secret-access-token");
    expect(warned).not.toContain("upstream echoed");
  });
});

describe("markRateLimited keeps session cooldown separate from weekly resets", () => {
  it("uses the caller's session cool-off instead of the weekly usage reset", async () => {
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

    const heuristic = Date.now() + 60_000;
    await pool.markRateLimited("claude-work", heuristic, "429", {
      providerId: "anthropic-subscription",
    });

    const marked = pool.get("claude-work", "anthropic-subscription");
    expect(marked?.health).toBe("rate-limited");
    expect(marked?.healthDetail?.until).toBe(heuristic);
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
