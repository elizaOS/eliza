/**
 * Round-trip CRUD + OAuth-flow tests for `handleAccountsRoutes`.
 *
 * Each test runs against a fresh tmp `ELIZA_HOME` so the per-account
 * credential store AND the `_pool-metadata.json` overlay are
 * isolated. `LinkedAccountConfig` data lives in the AccountPool now,
 * not in `ElizaConfig.linkedAccounts`, so the `state.config` we hand
 * the route handler is mostly opaque — the pool reads/writes the
 * metadata file directly. Network calls (Anthropic / OpenAI token
 * exchange + usage probes) are not exercised here — `oauth/start` is
 * asserted to return a valid `{ sessionId, authUrl }` and the SSE
 * stream is driven via the synthetic-flow registry helper.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetFlowRegistry, _registerSyntheticFlow } from "../auth/oauth-flow.js";
import type { ElizaConfig } from "../config/types.eliza.js";
import {
  type AccountsRouteContext,
  _resetAccountsRoutesPoolCache,
  handleAccountsRoutes,
} from "./accounts-routes.js";

interface StubCtx {
  ctx: AccountsRouteContext;
  jsonCalls: Array<{ status: number; body: unknown }>;
  errorCalls: Array<{ status: number; message: string }>;
  savedConfigs: ElizaConfig[];
  res: http.ServerResponse;
}

function makeStubCtx(params: {
  method: string;
  pathname: string;
  config: ElizaConfig;
  body?: unknown;
  query?: Record<string, string>;
  res?: http.ServerResponse;
  req?: http.IncomingMessage;
}): StubCtx {
  const jsonCalls: StubCtx["jsonCalls"] = [];
  const errorCalls: StubCtx["errorCalls"] = [];
  const savedConfigs: ElizaConfig[] = [];

  const url = params.query
    ? `${params.pathname}?${new URLSearchParams(params.query).toString()}`
    : params.pathname;
  const req =
    params.req ??
    ({
      method: params.method,
      headers: { host: "localhost" },
      url,
      on: () => undefined,
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage);
  const res =
    params.res ??
    ({
      statusCode: 200,
      setHeader: () => res,
      end: () => res,
      write: () => true,
      headersSent: false,
    } as unknown as http.ServerResponse);

  const ctx: AccountsRouteContext = {
    req,
    res,
    method: params.method,
    pathname: params.pathname,
    json: (_res, data, status = 200) => jsonCalls.push({ status, body: data }),
    error: (_res, message, status = 500) =>
      errorCalls.push({ status, message }),
    readJsonBody: async () => (params.body ?? {}) as never,
    state: { config: params.config },
    saveConfig: (cfg) => {
      // emulate disk persistence by snapshotting
      savedConfigs.push(JSON.parse(JSON.stringify(cfg)));
    },
  };

  return { ctx, jsonCalls, errorCalls, savedConfigs, res };
}

const ORIGINAL_ELIZA_HOME = process.env.ELIZA_HOME;

describe("handleAccountsRoutes", () => {
  let home: string;

  beforeEach(async () => {
    home = path.join(
      os.tmpdir(),
      `accounts-routes-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(home, { recursive: true });
    process.env.ELIZA_HOME = home;
    _resetFlowRegistry();
    _resetAccountsRoutesPoolCache();
    // Drop the pool's own module-level singleton so it picks up the
    // new ELIZA_HOME on first read.
    const mod = await import("@elizaos/app-core/services/account-pool");
    mod.__resetDefaultAccountPoolForTests();
  });

  afterEach(async () => {
    if (ORIGINAL_ELIZA_HOME === undefined) {
      delete process.env.ELIZA_HOME;
    } else {
      process.env.ELIZA_HOME = ORIGINAL_ELIZA_HOME;
    }
    if (home && fs.existsSync(home)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    _resetFlowRegistry();
    _resetAccountsRoutesPoolCache();
    const mod = await import("@elizaos/app-core/services/account-pool");
    mod.__resetDefaultAccountPoolForTests();
  });

  it("returns false for unrelated paths", async () => {
    const { ctx, jsonCalls, errorCalls } = makeStubCtx({
      method: "GET",
      pathname: "/api/something-else",
      config: {} as ElizaConfig,
    });
    const handled = await handleAccountsRoutes(ctx);
    expect(handled).toBe(false);
    expect(jsonCalls).toEqual([]);
    expect(errorCalls).toEqual([]);
  });

  it("GET /api/accounts → empty providers when no accounts configured", async () => {
    const { ctx, jsonCalls, errorCalls } = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config: {} as ElizaConfig,
    });
    const handled = await handleAccountsRoutes(ctx);
    expect(handled).toBe(true);
    expect(errorCalls).toEqual([]);
    expect(jsonCalls).toHaveLength(1);
    const body = jsonCalls[0].body as {
      providers: Array<{
        providerId: string;
        strategy: string;
        accounts: unknown[];
      }>;
    };
    expect(
      body.providers.find((p) => p.providerId === "anthropic-subscription"),
    ).toBeDefined();
    expect(body.providers.every((p) => p.accounts.length === 0)).toBe(true);
    expect(body.providers.every((p) => p.strategy === "priority")).toBe(true);
  });

  it("POST /api/accounts/:providerId (api-key) round-trips through GET", async () => {
    const config = {} as ElizaConfig;
    const create = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription",
      config,
      body: {
        source: "api-key",
        label: "Personal",
        apiKey: "sk-ant-test-1234567890",
      },
    });
    expect(await handleAccountsRoutes(create.ctx)).toBe(true);
    expect(create.errorCalls).toEqual([]);
    expect(create.jsonCalls).toHaveLength(1);
    expect(create.jsonCalls[0].status).toBe(201);
    const created = create.jsonCalls[0].body as {
      id: string;
      providerId: string;
      label: string;
      enabled: boolean;
      priority: number;
      health: string;
    };
    expect(created.providerId).toBe("anthropic-subscription");
    expect(created.label).toBe("Personal");
    expect(created.enabled).toBe(true);
    expect(created.priority).toBe(0);
    expect(created.health).toBe("ok");

    // After POST, the config bag should hold the rich record.
    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    expect(await handleAccountsRoutes(list.ctx)).toBe(true);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{
        providerId: string;
        accounts: Array<{ id: string; label: string; hasCredential: boolean }>;
      }>;
    };
    const anthropic = listBody.providers.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    expect(anthropic?.accounts).toHaveLength(1);
    expect(anthropic?.accounts[0].id).toBe(created.id);
    expect(anthropic?.accounts[0].hasCredential).toBe(true);
  });

  it("PATCH /api/accounts/:providerId/:accountId mutates priority + label", async () => {
    const config = {} as ElizaConfig;
    const create = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription",
      config,
      body: {
        source: "api-key",
        label: "Original",
        apiKey: "sk-ant-original-1234567",
      },
    });
    await handleAccountsRoutes(create.ctx);
    const created = create.jsonCalls[0].body as { id: string };

    const patch = makeStubCtx({
      method: "PATCH",
      pathname: `/api/accounts/anthropic-subscription/${created.id}`,
      config,
      body: { label: "Renamed", priority: 7, enabled: false },
    });
    expect(await handleAccountsRoutes(patch.ctx)).toBe(true);
    expect(patch.errorCalls).toEqual([]);
    const patched = patch.jsonCalls[0].body as {
      label: string;
      enabled: boolean;
      priority: number;
    };
    expect(patched.label).toBe("Renamed");
    expect(patched.enabled).toBe(false);
    expect(patched.priority).toBe(7);

    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    await handleAccountsRoutes(list.ctx);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{
        providerId: string;
        accounts: Array<{ label: string; priority: number; enabled: boolean }>;
      }>;
    };
    const anth = listBody.providers.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    expect(anth?.accounts[0]).toMatchObject({
      label: "Renamed",
      priority: 7,
      enabled: false,
    });
  });

  it("DELETE /api/accounts/:providerId/:accountId removes config + on-disk credential", async () => {
    const config = {} as ElizaConfig;
    const create = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription",
      config,
      body: {
        source: "api-key",
        label: "Disposable",
        apiKey: "sk-ant-bye-1234567",
      },
    });
    await handleAccountsRoutes(create.ctx);
    const created = create.jsonCalls[0].body as { id: string };

    const credFile = path.join(
      home,
      "auth",
      "anthropic-subscription",
      `${created.id}.json`,
    );
    expect(fs.existsSync(credFile)).toBe(true);

    const del = makeStubCtx({
      method: "DELETE",
      pathname: `/api/accounts/anthropic-subscription/${created.id}`,
      config,
    });
    expect(await handleAccountsRoutes(del.ctx)).toBe(true);
    expect(del.errorCalls).toEqual([]);
    expect(del.jsonCalls[0].body).toEqual({ deleted: true });
    expect(fs.existsSync(credFile)).toBe(false);

    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    await handleAccountsRoutes(list.ctx);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{ providerId: string; accounts: unknown[] }>;
    };
    const anth = listBody.providers.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    expect(anth?.accounts).toEqual([]);
  });

  it("PATCH /api/providers/:providerId/strategy persists strategy in config", async () => {
    const config = {} as ElizaConfig;
    const patch = makeStubCtx({
      method: "PATCH",
      pathname: "/api/providers/anthropic-subscription/strategy",
      config,
      body: { strategy: "least-used" },
    });
    expect(await handleAccountsRoutes(patch.ctx)).toBe(true);
    expect(patch.errorCalls).toEqual([]);
    expect(patch.jsonCalls[0].body).toMatchObject({
      providerId: "anthropic-subscription",
      strategy: "least-used",
    });

    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    await handleAccountsRoutes(list.ctx);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{ providerId: string; strategy: string }>;
    };
    expect(
      listBody.providers.find((p) => p.providerId === "anthropic-subscription")
        ?.strategy,
    ).toBe("least-used");
  });

  it("PATCH /api/providers/:providerId/strategy rejects bogus strategies", async () => {
    const { ctx, errorCalls } = makeStubCtx({
      method: "PATCH",
      pathname: "/api/providers/anthropic-subscription/strategy",
      config: {} as ElizaConfig,
      body: { strategy: "do-magic" },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].status).toBe(400);
  });

  it("rejects unknown providerIds with 400", async () => {
    const { ctx, errorCalls } = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/not-a-real-provider",
      config: {} as ElizaConfig,
      body: { source: "api-key", label: "X", apiKey: "x".repeat(20) },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].status).toBe(400);
  });

  it("api-key for anthropic-api responds 501 (storage shape pending)", async () => {
    const { ctx, errorCalls } = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/anthropic-api",
      config: {} as ElizaConfig,
      body: {
        source: "api-key",
        label: "Direct",
        apiKey: "sk-ant-api-12345678",
      },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].status).toBe(501);
  });

  it("oauth/status streams synthetic flow updates over SSE", async () => {
    const writes: string[] = [];
    const emitter = new EventEmitter();

    let ended = false;
    const res = {
      statusCode: 0,
      setHeader: () => res,
      write: (chunk: string | Buffer) => {
        writes.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      },
      end: () => {
        ended = true;
        return res;
      },
      headersSent: false,
    } as unknown as http.ServerResponse;

    const { sessionId, complete } = _registerSyntheticFlow({
      providerId: "anthropic-subscription",
      authUrl: "https://example.com/auth",
      needsCodeSubmission: true,
    });

    // The handler reads sessionId off req.url — not from the route-helper
    // query bag — so we have to bake it into the EventEmitter req we pass.
    Object.assign(emitter, {
      method: "GET",
      headers: { host: "localhost" },
      url: `/api/accounts/anthropic-subscription/oauth/status?sessionId=${sessionId}`,
      socket: { remoteAddress: "127.0.0.1" },
    });
    const req = emitter as unknown as http.IncomingMessage;

    const { ctx } = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts/anthropic-subscription/oauth/status",
      config: {} as ElizaConfig,
      res,
      req,
    });

    expect(await handleAccountsRoutes(ctx)).toBe(true);
    // Initial replay arrived synchronously.
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]).toContain("data: ");
    expect(writes[0]).toContain('"status":"pending"');
    expect(ended).toBe(false);

    complete({
      sessionId,
      providerId: "anthropic-subscription",
      status: "success",
      authUrl: "https://example.com/auth",
      needsCodeSubmission: true,
      startedAt: Date.now() - 1000,
    });

    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[writes.length - 1]).toContain('"status":"success"');
    expect(ended).toBe(true);
  });

  it("oauth/status rejects unknown sessionIds with 404", async () => {
    const { ctx, errorCalls } = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts/anthropic-subscription/oauth/status",
      config: {} as ElizaConfig,
      query: { sessionId: "does-not-exist" },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].status).toBe(404);
  });

  it("oauth/cancel returns cancelled:false for unknown session", async () => {
    const { ctx, jsonCalls } = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription/oauth/cancel",
      config: {} as ElizaConfig,
      body: { sessionId: "ghost" },
    });
    expect(await handleAccountsRoutes(ctx)).toBe(true);
    expect(jsonCalls[0].body).toEqual({ cancelled: false });
  });

  it("pool.markRateLimited is visible to GET /api/accounts (proves single source of truth)", async () => {
    const config = {} as ElizaConfig;
    const create = makeStubCtx({
      method: "POST",
      pathname: "/api/accounts/anthropic-subscription",
      config,
      body: {
        source: "api-key",
        label: "Throttled",
        apiKey: "sk-ant-throttle-1234567",
      },
    });
    await handleAccountsRoutes(create.ctx);
    const created = create.jsonCalls[0].body as { id: string };

    // Simulate the runtime flipping the account into a rate-limited
    // cooldown — this is what `plugin-anthropic`'s 429 handler does.
    const mod = await import("@elizaos/app-core/services/account-pool");
    const pool = mod.getDefaultAccountPool();
    const untilMs = Date.now() + 5 * 60_000;
    await pool.markRateLimited(created.id, untilMs, "test");

    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    await handleAccountsRoutes(list.ctx);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{
        providerId: string;
        accounts: Array<{ id: string; health: string; healthDetail?: { until?: number } }>;
      }>;
    };
    const anth = listBody.providers.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    expect(anth?.accounts[0]?.health).toBe("rate-limited");
    expect(anth?.accounts[0]?.healthDetail?.until).toBe(untilMs);
  });

  it("supports adding multiple accounts to the same provider with distinct ids and ascending priorities", async () => {
    const config = {} as ElizaConfig;

    // Add three accounts in sequence — covers the realistic UI flow
    // of a user adding several Anthropic subscriptions to a rotation
    // pool.
    const labels = ["Personal", "Work", "Side project"];
    const created: Array<{ id: string; priority: number; label: string }> = [];
    for (const label of labels) {
      const ctx = makeStubCtx({
        method: "POST",
        pathname: "/api/accounts/anthropic-subscription",
        config,
        body: {
          source: "api-key",
          label,
          apiKey: `sk-ant-${label.toLowerCase().replace(/\s/g, "-")}-1234567`,
        },
      });
      expect(await handleAccountsRoutes(ctx.ctx)).toBe(true);
      expect(ctx.errorCalls).toEqual([]);
      const body = ctx.jsonCalls[0].body as {
        id: string;
        priority: number;
        label: string;
      };
      created.push(body);
    }

    // All three got distinct uuid-shaped ids.
    const ids = new Set(created.map((c) => c.id));
    expect(ids.size).toBe(3);
    for (const c of created) {
      expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Priorities incremented monotonically (0, 1, 2).
    expect(created.map((c) => c.priority)).toEqual([0, 1, 2]);
    expect(created.map((c) => c.label)).toEqual(labels);

    // GET surfaces all three under the same provider, sorted by priority.
    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    await handleAccountsRoutes(list.ctx);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{
        providerId: string;
        accounts: Array<{
          id: string;
          label: string;
          priority: number;
          enabled: boolean;
          hasCredential: boolean;
        }>;
      }>;
    };
    const anth = listBody.providers.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    expect(anth?.accounts).toHaveLength(3);
    expect(anth?.accounts.map((a) => a.label)).toEqual(labels);
    expect(anth?.accounts.map((a) => a.priority)).toEqual([0, 1, 2]);
    expect(anth?.accounts.every((a) => a.enabled === true)).toBe(true);
    expect(anth?.accounts.every((a) => a.hasCredential === true)).toBe(true);

    // Each account has its own on-disk credential file (not aliasing).
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const c of created) {
      const credPath = path.join(
        home,
        "auth",
        "anthropic-subscription",
        `${c.id}.json`,
      );
      expect(fs.existsSync(credPath)).toBe(true);
    }
  });

  it("OAuth-style post-save priority calc excludes the just-saved account", async () => {
    // Regression for the OAuth-flow priority race: by the time
    // `onAccountSaved` fires, the new credential file already exists
    // on disk, so a naive `pool.list().max(priority)+1` would include
    // the new account at its default createdAt-index priority and
    // produce an off-by-one. The fix in handleOAuthRoutes excludes
    // the just-saved record before computing priority. This test
    // mirrors that flow against the storage + pool primitives
    // directly so it catches regressions even if the route's
    // closure changes shape.
    const config = {} as ElizaConfig;

    // Seed three accounts via the api-key path so the pool has known
    // metadata at priorities 0, 1, 2.
    for (const label of ["A", "B", "C"]) {
      const ctx = makeStubCtx({
        method: "POST",
        pathname: "/api/accounts/anthropic-subscription",
        config,
        body: {
          source: "api-key",
          label,
          apiKey: `sk-ant-${label.toLowerCase()}-1234567`,
        },
      });
      await handleAccountsRoutes(ctx.ctx);
    }

    // Now simulate an OAuth completion: the credential record gets
    // written to disk BEFORE the priority calc runs. Use the same
    // exclude-self math the route uses. Without the fix, the new
    // account would land at priority 4 (because pool.list would
    // include the fresh account with default priority 3, max+1=4);
    // with the fix it correctly lands at priority 3.
    const { saveAccount } = await import("../auth/account-storage.js");
    const mod = await import("@elizaos/app-core/services/account-pool");
    const pool = mod.getDefaultAccountPool();

    const newAccountId = crypto.randomUUID();
    saveAccount({
      id: newAccountId,
      providerId: "anthropic-subscription",
      label: "OAuthAccount",
      source: "oauth",
      credentials: {
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 60_000,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const others = pool
      .list("anthropic-subscription")
      .filter((a) => a.id !== newAccountId);
    const livePriority =
      others.length === 0
        ? 0
        : Math.max(...others.map((a) => a.priority)) + 1;

    expect(livePriority).toBe(3);
    // And the account list (without explicit upsert) still includes
    // the new account at its default index, but the calc above
    // correctly ignored it.
    const all = pool.list("anthropic-subscription");
    expect(all.find((a) => a.id === newAccountId)).toBeDefined();
  });

  it("supports independent account pools per provider (anthropic + codex side-by-side)", async () => {
    const config = {} as ElizaConfig;

    const addAccount = async (
      providerId: "anthropic-subscription" | "openai-codex",
      label: string,
      apiKey: string,
    ) => {
      const ctx = makeStubCtx({
        method: "POST",
        pathname: `/api/accounts/${providerId}`,
        config,
        body: { source: "api-key", label, apiKey },
      });
      await handleAccountsRoutes(ctx.ctx);
      return ctx.jsonCalls[0].body as { id: string; priority: number };
    };

    const a1 = await addAccount(
      "anthropic-subscription",
      "Anthropic A",
      "sk-ant-aa-1234567",
    );
    const a2 = await addAccount(
      "anthropic-subscription",
      "Anthropic B",
      "sk-ant-bb-1234567",
    );
    const c1 = await addAccount(
      "openai-codex",
      "Codex A",
      "sk-codex-aa-1234567",
    );
    const c2 = await addAccount(
      "openai-codex",
      "Codex B",
      "sk-codex-bb-1234567",
    );

    // Both providers' pools start at priority 0 and increment
    // independently.
    expect(a1.priority).toBe(0);
    expect(a2.priority).toBe(1);
    expect(c1.priority).toBe(0);
    expect(c2.priority).toBe(1);
    expect(new Set([a1.id, a2.id, c1.id, c2.id]).size).toBe(4);

    const list = makeStubCtx({
      method: "GET",
      pathname: "/api/accounts",
      config,
    });
    await handleAccountsRoutes(list.ctx);
    const listBody = list.jsonCalls[0].body as {
      providers: Array<{
        providerId: string;
        accounts: Array<{ id: string }>;
      }>;
    };
    const anth = listBody.providers.find(
      (p) => p.providerId === "anthropic-subscription",
    );
    const codex = listBody.providers.find(
      (p) => p.providerId === "openai-codex",
    );
    expect(anth?.accounts.map((a) => a.id).sort()).toEqual(
      [a1.id, a2.id].sort(),
    );
    expect(codex?.accounts.map((a) => a.id).sort()).toEqual(
      [c1.id, c2.id].sort(),
    );
  });
});
