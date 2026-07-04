/**
 * REAL mid-session inference failover: account 1 hits an upstream 429 and the
 * request is served by account 2 — driven end-to-end through the production
 * stack, with the ONLY simulation at the network boundary (a local HTTP server
 * standing in for api.anthropic.com; never a mocked pool, bridge, or fetch).
 *
 * The path under test (issue #11032 lineage / QA umbrella #10722):
 *
 *   ai.generateText
 *     → @ai-sdk/anthropic client from plugin-anthropic's
 *       `createAnthropicClientWithTopPSupport` (ANTHROPIC_AUTH_MODE=oauth)
 *     → the plugin's OAuth fetch wrapper (`createOAuthFetch`)
 *     → `getClaudeOAuthTokenAsync` → the REAL anthropic pool bridge installed
 *       by `getDefaultAccountPool()` → REAL AccountPool over the REAL on-disk
 *       credential store (throwaway ELIZA_HOME)
 *     → Bearer <account-1 token> → upstream 429 (with the unified reset header)
 *     → `reportClaudeOAuthRateLimited` → REAL `pool.markRateLimited`
 *     → re-select with `exclude:[account-1]` → Bearer <account-2 token>
 *     → upstream 200 → the caller gets a completion, not an error.
 *
 * Asserts OUTCOMES: the completion text arrives (session continuity), the
 * upstream saw account 1 then account 2 (which account served), the pool
 * persists account 1 as rate-limited until the provider's reset, and the NEXT
 * request goes straight to account 2 (single upstream hit). Also covers the
 * 401 → invalid → failover path and upstream request accounting for both.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import type { IAgentRuntime } from "@elizaos/core";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Relative source import (repo convention for cross-package test imports —
// the plugin build does not emit dist/providers/, so the package subpath
// export cannot resolve this module).
import { createAnthropicClientWithTopPSupport } from "../../../../plugins/plugin-anthropic/providers/anthropic.ts";
import { clearTokenCache } from "../../../../plugins/plugin-anthropic/utils/credential-store.ts";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "../../src/services/account-pool.js";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
const TOKEN_A = "sk-ant-oat-ACCOUNT-A";
const TOKEN_B = "sk-ant-oat-ACCOUNT-B";
const MODEL = "claude-haiku-4-5-20251001";
// Assigned port range for this workstream: 34100-34199.
const PORT_RANGE_START = 34120;
const PORT_RANGE_END = 34140;

interface SeenRequest {
  bearer: string | null;
  path: string;
}

interface FakeUpstream {
  server: http.Server;
  baseUrl: string;
  seen: SeenRequest[];
  /** Per-token behavior: "429" | "401" | "ok". */
  behavior: Map<string, "429" | "401" | "ok">;
  resetEpochSec: number;
  close: () => Promise<void>;
}

function messagesResponseBody(text: string): string {
  return JSON.stringify({
    id: "msg_e2e_fake_upstream",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5 },
  });
}

// Each upstream instance takes a FRESH port from the assigned range. Reusing
// one port across sequential tests lets undici's global fetch pool hand the
// next test a stale keep-alive connection to the previous (closed) server —
// the first request of the next test then dies with `read ECONNRESET` before
// it ever reaches the new upstream. A fresh origin per test gets a fresh pool.
let nextPort = PORT_RANGE_START;

async function listenInRange(server: http.Server): Promise<number> {
  if (nextPort > PORT_RANGE_END) nextPort = PORT_RANGE_START;
  for (let port = nextPort; port <= PORT_RANGE_END; port++) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });
    if (bound) {
      nextPort = port + 1;
      return port;
    }
  }
  throw new Error(
    `No free port in assigned range ${PORT_RANGE_START}-${PORT_RANGE_END}`,
  );
}

/** Local stand-in for api.anthropic.com — the ONLY simulated boundary. */
async function startFakeAnthropicUpstream(): Promise<FakeUpstream> {
  const seen: SeenRequest[] = [];
  const behavior = new Map<string, "429" | "401" | "ok">();
  const resetEpochSec = Math.floor(Date.now() / 1000) + 4 * 3600;

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    const bearer = auth?.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : null;
    seen.push({ bearer, path: req.url ?? "" });
    // Drain the request body before responding.
    req.resume();
    req.on("end", () => {
      const mode = (bearer && behavior.get(bearer)) || "ok";
      if (mode === "429") {
        res.writeHead(429, {
          "content-type": "application/json",
          // The plugin cancels the error body before retrying; close the
          // socket so the retry never reuses a half-torn keep-alive pipe.
          connection: "close",
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": String(resetEpochSec),
        });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Rate limited" },
          }),
        );
        return;
      }
      if (mode === "401") {
        res.writeHead(401, {
          "content-type": "application/json",
          connection: "close",
        });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid bearer token",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(messagesResponseBody(`served-by:${bearer ?? "unknown"}`));
    });
  });

  const port = await listenInRange(server);
  const { address } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://${address}:${port}/v1`,
    seen,
    behavior,
    resetEpochSec,
    close: () =>
      new Promise<void>((resolve) => {
        // Tear down lingering keep-alive sockets so close() cannot hang and
        // no half-dead connection outlives the test.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function writeSubscriptionAccount(
  id: string,
  access: string,
  createdAt: number,
): void {
  saveAccount({
    id,
    providerId: "anthropic-subscription",
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

function oauthRuntime(baseUrl: string): IAgentRuntime {
  const settings: Record<string, string> = {
    ANTHROPIC_AUTH_MODE: "oauth",
    ANTHROPIC_BASE_URL: baseUrl,
  };
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

const SAVED_ENV_KEYS = [
  "ELIZA_HOME",
  "ELIZA_STATE_DIR",
  "HOME",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID",
  "ELIZA_MOCK_ANTHROPIC_BASE",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
] as const;

let home: string;
let savedEnv: Record<string, string | undefined>;
let upstream: FakeUpstream;

beforeEach(async () => {
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key];
  home = mkdtempSync(path.join(tmpdir(), "multi-acct-429-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  // Hermetic: no env-token shortcut, no machine ~/.eliza or keychain
  // fallback, no leftover mock-base override.
  process.env.HOME = home;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_SUBSCRIPTION_ACCOUNT_ID;
  delete process.env.ELIZA_MOCK_ANTHROPIC_BASE;
  __resetDefaultAccountPoolForTests();
  clearTokenCache();
  upstream = await startFakeAnthropicUpstream();
});

afterEach(async () => {
  await upstream.close();
  __resetDefaultAccountPoolForTests();
  clearTokenCache();
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("mid-session upstream 429 → real pool failover (plugin-anthropic OAuth path)", () => {
  it("serves the request from the sibling account after the active one 429s, and persists the rate-limit", async () => {
    writeSubscriptionAccount("acct-a", TOKEN_A, 1_000);
    writeSubscriptionAccount("acct-b", TOKEN_B, 2_000);
    const pool = getDefaultAccountPool(); // installs the REAL anthropic bridge
    upstream.behavior.set(TOKEN_A, "429");
    upstream.behavior.set(TOKEN_B, "ok");

    const client = createAnthropicClientWithTopPSupport(
      oauthRuntime(upstream.baseUrl),
    );
    const result = await generateText({
      model: client(MODEL),
      prompt: "hello",
      maxRetries: 0,
    });

    // Session continuity: the caller got a completion — served by account B.
    expect(result.text).toBe(`served-by:${TOKEN_B}`);

    // The upstream really saw the failover: Bearer A (429) then Bearer B (200).
    const bearers = upstream.seen.map((r) => r.bearer);
    expect(bearers).toEqual([TOKEN_A, TOKEN_B]);
    expect(upstream.seen.every((r) => r.path.endsWith("/messages"))).toBe(true);

    // The REAL pool marked account A rate-limited until the provider's own
    // unified reset timestamp (header epoch seconds → ms).
    const marked = pool.get("acct-a", "anthropic-subscription");
    expect(marked?.health).toBe("rate-limited");
    expect(marked?.healthDetail?.until).toBe(upstream.resetEpochSec * 1000);
    expect(marked?.healthDetail?.lastError).toContain("429");

    // ...and persisted it to the on-disk overlay (survives a restart).
    const overlay = JSON.parse(
      readFileSync(path.join(home, "auth", "_pool-metadata.json"), "utf-8"),
    ) as Record<string, Record<string, { health?: string }>>;
    expect(overlay["anthropic-subscription"]?.["acct-a"]?.health).toBe(
      "rate-limited",
    );

    // The NEXT request goes straight to the healthy sibling: exactly one more
    // upstream hit, Bearer B.
    const before = upstream.seen.length;
    const second = await generateText({
      model: client(MODEL),
      prompt: "again",
      maxRetries: 0,
    });
    expect(second.text).toBe(`served-by:${TOKEN_B}`);
    expect(upstream.seen.slice(before).map((r) => r.bearer)).toEqual([TOKEN_B]);
  });

  it("fails over on an upstream 401 and marks the account invalid (never re-served)", async () => {
    writeSubscriptionAccount("acct-a", TOKEN_A, 1_000);
    writeSubscriptionAccount("acct-b", TOKEN_B, 2_000);
    const pool = getDefaultAccountPool();
    upstream.behavior.set(TOKEN_A, "401");
    upstream.behavior.set(TOKEN_B, "ok");

    const client = createAnthropicClientWithTopPSupport(
      oauthRuntime(upstream.baseUrl),
    );
    const result = await generateText({
      model: client(MODEL),
      prompt: "hello",
      maxRetries: 0,
    });

    expect(result.text).toBe(`served-by:${TOKEN_B}`);
    expect(upstream.seen.map((r) => r.bearer)).toEqual([TOKEN_A, TOKEN_B]);

    const marked = pool.get("acct-a", "anthropic-subscription");
    expect(marked?.health).toBe("invalid");

    // Invalid accounts are never readmitted by the eligibility gate: the next
    // call selects B directly.
    const before = upstream.seen.length;
    await generateText({ model: client(MODEL), prompt: "x", maxRetries: 0 });
    expect(upstream.seen.slice(before).map((r) => r.bearer)).toEqual([TOKEN_B]);
  });

  it("keeps serving from the healthy account when no failure occurs (no spurious failover)", async () => {
    writeSubscriptionAccount("acct-a", TOKEN_A, 1_000);
    writeSubscriptionAccount("acct-b", TOKEN_B, 2_000);
    const pool = getDefaultAccountPool();

    const client = createAnthropicClientWithTopPSupport(
      oauthRuntime(upstream.baseUrl),
    );
    for (let i = 0; i < 2; i++) {
      const result = await generateText({
        model: client(MODEL),
        prompt: `turn ${i}`,
        maxRetries: 0,
      });
      expect(result.text).toBe(`served-by:${TOKEN_A}`);
    }
    // Priority pick is stable, both accounts stay healthy.
    expect(upstream.seen.map((r) => r.bearer)).toEqual([TOKEN_A, TOKEN_A]);
    expect(pool.get("acct-a", "anthropic-subscription")?.health).toBe("ok");
    expect(pool.get("acct-b", "anthropic-subscription")?.health).toBe("ok");
  });
});
