/**
 * Focused coverage for the localhost-only account-pool broker HTTP surface.
 * Tests use real temp account-storage records and the default AccountPool
 * singleton, while provider calls are avoided by storing far-future access
 * tokens that do not require refresh.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import type { AccountCredentialProvider } from "@elizaos/auth/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetDefaultAccountPoolForTests,
  getDefaultAccountPool,
} from "../services/account-pool.js";
import {
  __resetAccountPoolBrokerRoutesForTests,
  handleAccountPoolBrokerRoute,
} from "./account-pool-broker-routes.js";

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  header(name: string): string | number | readonly string[] | undefined;
  status(): number;
}

const SECRET = "test-broker-fixture-test-broker-fixture-test";
const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;

let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevEnabled: string | undefined;
let prevSecret: string | undefined;
let prevTtl: string | undefined;

function fakeRes(): FakeRes {
  let bodyText = "";
  const headers = new Map<string, string | number | readonly string[]>();
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = ((
    name: string,
    value: string | number | readonly string[],
  ) => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : value);
    return res;
  }) as typeof res.setHeader;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(
  pathname: string,
  options: {
    method?: string;
    auth?: string;
    body?: Record<string, unknown>;
    remoteAddress?: string;
  } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = options.method ?? "POST";
  req.url = pathname;
  req.headers = { host: "127.0.0.1:18792" };
  if (options.auth !== undefined) req.headers.authorization = options.auth;
  if (options.body !== undefined) {
    (req as { body?: unknown }).body = options.body;
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  return req;
}

function writeAccount(
  providerId: AccountCredentialProvider,
  id: string,
  access: string,
  extra: { organizationId?: string } = {},
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });
}

async function postBroker(
  pathSuffix: string,
  body: Record<string, unknown>,
): Promise<FakeRes> {
  const res = fakeRes();
  await handleAccountPoolBrokerRoute(
    fakeReq(`/internal/account-pool/v1/${pathSuffix}`, {
      auth: `Bearer ${SECRET}`,
      body,
    }),
    res.res,
  );
  return res;
}

async function lease(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await postBroker("lease", body);
  expect(res.status()).toBe(200);
  return res.body() as Record<string, unknown>;
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevEnabled = process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
  prevSecret = process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  prevTtl = process.env.ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS;
  home = mkdtempSync(path.join(tmpdir(), "account-pool-broker-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = "1";
  process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = SECRET;
  delete process.env.ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS;
  __resetDefaultAccountPoolForTests();
  __resetAccountPoolBrokerRoutesForTests();
});

afterEach(() => {
  __resetAccountPoolBrokerRoutesForTests();
  __resetDefaultAccountPoolForTests();
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevEnabled === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = prevEnabled;
  if (prevSecret === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = prevSecret;
  if (prevTtl === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_LEASE_TTL_MS = prevTtl;
  rmSync(home, { recursive: true, force: true });
});

describe("account-pool broker route auth", () => {
  it("is absent unless explicitly enabled with a strong bearer secret", async () => {
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
    const res = fakeRes();
    const handled = await handleAccountPoolBrokerRoute(
      fakeReq("/internal/account-pool/v1/health", {
        method: "GET",
        auth: `Bearer ${SECRET}`,
      }),
      res.res,
    );
    expect(handled).toBe(false);

    process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = "1";
    process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = "short";
    const weak = fakeRes();
    expect(
      await handleAccountPoolBrokerRoute(
        fakeReq("/internal/account-pool/v1/health", {
          method: "GET",
          auth: "Bearer short",
        }),
        weak.res,
      ),
    ).toBe(false);
  });

  it("rejects non-loopback callers before serving the broker", async () => {
    const res = fakeRes();
    const handled = await handleAccountPoolBrokerRoute(
      fakeReq("/internal/account-pool/v1/health", {
        method: "GET",
        auth: `Bearer ${SECRET}`,
        remoteAddress: "10.0.0.8",
      }),
      res.res,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(403);
    expect(res.header("Cache-Control")).toBe("no-store");
    expect(res.body()).toEqual({ ok: false, error: "loopback_only" });
  });

  it("requires bearer auth and never echoes the secret in errors", async () => {
    const res = fakeRes();
    await handleAccountPoolBrokerRoute(
      fakeReq("/internal/account-pool/v1/health", {
        method: "GET",
        auth: "Bearer wrong-secret",
      }),
      res.res,
    );
    expect(res.status()).toBe(401);
    expect(JSON.stringify(res.body())).not.toContain(SECRET);
    expect(res.header("Cache-Control")).toBe("no-store");
  });
});

describe("account-pool broker lease flow", () => {
  it("leases an access token, omits refresh tokens, and returns no-store", async () => {
    writeAccount("anthropic-subscription", "primary", "sk-ant-oat-primary");
    const res = await postBroker("lease", {
      providerId: "anthropic-subscription",
      sessionKey: "openclaw:s1",
      strategy: "priority",
      exclude: [],
    });
    expect(res.status()).toBe(200);
    expect(res.header("Cache-Control")).toBe("no-store");
    const body = res.body() as Record<string, unknown>;
    expect(body.accountId).toBe("primary");
    expect(body.accessToken).toBe("sk-ant-oat-primary");
    expect(JSON.stringify(body)).not.toContain("refresh");
  });

  it("keeps explicit session affinity until exclusion forces a switch", async () => {
    writeAccount("anthropic-subscription", "primary", "token-primary");
    writeAccount("anthropic-subscription", "spare", "token-spare");
    const pool = getDefaultAccountPool();
    const spare = pool.get("spare", "anthropic-subscription");
    if (!spare) throw new Error("missing spare");
    await pool.upsert({
      ...spare,
      priority: 1,
      usage: { sessionPct: 0, refreshedAt: Date.now() },
    });
    const primary = pool.get("primary", "anthropic-subscription");
    if (!primary) throw new Error("missing primary");
    await pool.upsert({
      ...primary,
      priority: 0,
      usage: { sessionPct: 99, refreshedAt: Date.now() },
    });

    const first = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "openclaw:same-session",
      strategy: "priority",
    });
    const pinned = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "openclaw:same-session",
      strategy: "least-used",
    });
    const switched = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "openclaw:same-session",
      strategy: "least-used",
      exclude: ["primary"],
    });

    expect(first.accountId).toBe("primary");
    expect(pinned.accountId).toBe("primary");
    expect(switched.accountId).toBe("spare");
  });

  it("returns the ChatGPT account id for Codex leases without exposing refresh tokens", async () => {
    writeAccount("openai-codex", "codex", "codex-access", {
      organizationId: "acct_123",
    });
    const body = await lease({
      providerId: "openai-codex",
      sessionKey: "openclaw:codex",
      strategy: "priority",
    });
    expect(body.accountId).toBe("codex");
    expect(body.chatgptAccountId).toBe("acct_123");
    expect(body.accessToken).toBe("codex-access");
    expect(JSON.stringify(body)).not.toContain("codex-access-refresh");
  });
});

describe("account-pool broker consumer key management", () => {
  it("returns structured no-store 400 for malformed consumer key ids", async () => {
    const res = fakeRes();
    await handleAccountPoolBrokerRoute(
      fakeReq("/internal/account-pool/v1/consumer-keys/%E0%A4%A", {
        method: "PATCH",
        auth: `Bearer ${SECRET}`,
        body: {
          label: "broken",
        },
      }),
      res.res,
    );
    expect(res.status()).toBe(400);
    expect(res.header("Cache-Control")).toBe("no-store");
    expect(res.body()).toEqual({
      ok: false,
      error: "invalid_consumer_key_id",
    });
  });

  it("creates, lists, updates, and rotates consumer keys without listing plaintext", async () => {
    const created = await postBroker("consumer-keys", {
      label: "proxy",
      dailyTokenQuota: 123,
    });
    expect(created.status()).toBe(201);
    const createdBody = created.body() as Record<string, unknown>;
    expect(createdBody.key).toEqual(expect.stringMatching(/^eliza_cp_/));
    expect(createdBody.consumer).toMatchObject({
      label: "proxy",
      enabled: true,
      dailyTokenQuota: 123,
    });
    const consumer = createdBody.consumer as Record<string, unknown>;
    const id = String(consumer.id);

    const listed = fakeRes();
    await handleAccountPoolBrokerRoute(
      fakeReq("/internal/account-pool/v1/consumer-keys", {
        method: "GET",
        auth: `Bearer ${SECRET}`,
      }),
      listed.res,
    );
    expect(listed.status()).toBe(200);
    expect(JSON.stringify(listed.body())).not.toContain(
      String(createdBody.key),
    );
    expect(listed.body()).toMatchObject({
      ok: true,
      keys: [
        {
          id,
          label: "proxy",
          enabled: true,
          dailyTokenQuota: 123,
        },
      ],
    });

    const updated = fakeRes();
    await handleAccountPoolBrokerRoute(
      fakeReq(`/internal/account-pool/v1/consumer-keys/${id}`, {
        method: "PATCH",
        auth: `Bearer ${SECRET}`,
        body: {
          label: "proxy-renamed",
          enabled: false,
          dailyTokenQuota: null,
        },
      }),
      updated.res,
    );
    expect(updated.status()).toBe(200);
    expect(updated.body()).toMatchObject({
      ok: true,
      consumer: {
        id,
        label: "proxy-renamed",
        enabled: false,
        dailyTokenQuota: null,
      },
    });

    const rotated = fakeRes();
    await handleAccountPoolBrokerRoute(
      fakeReq(`/internal/account-pool/v1/consumer-keys/${id}/rotate`, {
        method: "POST",
        auth: `Bearer ${SECRET}`,
      }),
      rotated.res,
    );
    expect(rotated.status()).toBe(200);
    expect((rotated.body() as Record<string, unknown>).key).toEqual(
      expect.stringMatching(/^eliza_cp_/),
    );
    expect((rotated.body() as Record<string, unknown>).key).not.toBe(
      createdBody.key,
    );
  });
});

describe("account-pool broker report/release flow", () => {
  it("classifies success, rate-limit, auth failure, and transient failures", async () => {
    writeAccount("anthropic-subscription", "ok", "token-ok");
    writeAccount("anthropic-subscription", "limited", "token-limited");
    writeAccount("anthropic-subscription", "revoked", "token-revoked");
    writeAccount("anthropic-subscription", "outage", "token-outage");

    const success = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "success",
      strategy: "priority",
      exclude: ["limited", "revoked", "outage"],
    });
    await postBroker("report", {
      leaseId: success.leaseId,
      ok: true,
      httpStatus: 200,
      tokens: 42,
      latencyMs: 12,
    });
    expect(
      getDefaultAccountPool().get("ok", "anthropic-subscription")?.health,
    ).toBe("ok");

    const limited = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "limited",
      strategy: "priority",
      exclude: ["ok", "revoked", "outage"],
    });
    await postBroker("report", {
      leaseId: limited.leaseId,
      ok: false,
      httpStatus: 429,
      errorCode: "rate_limit_exceeded",
      retryAfterMs: 120_000,
    });
    expect(
      getDefaultAccountPool().get("limited", "anthropic-subscription")?.health,
    ).toBe("rate-limited");

    const revoked = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "revoked",
      strategy: "priority",
      exclude: ["ok", "limited", "outage"],
    });
    await postBroker("report", {
      leaseId: revoked.leaseId,
      ok: false,
      httpStatus: 401,
      errorCode: "invalid_grant",
    });
    expect(
      getDefaultAccountPool().get("revoked", "anthropic-subscription")?.health,
    ).toBe("needs-reauth");

    const outage = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "outage",
      strategy: "priority",
      exclude: ["ok", "limited", "revoked"],
    });
    await postBroker("report", {
      leaseId: outage.leaseId,
      ok: false,
      httpStatus: 503,
      errorCode: "provider_overload",
    });
    expect(
      getDefaultAccountPool().get("outage", "anthropic-subscription")?.health,
    ).toBe("ok");
  });

  it("release expires a lease for later reports", async () => {
    writeAccount("anthropic-subscription", "primary", "token-primary");
    const leased = await lease({
      providerId: "anthropic-subscription",
      sessionKey: "release-me",
      strategy: "priority",
    });
    const released = await postBroker("release", {
      leaseId: leased.leaseId,
    });
    expect(released.status()).toBe(200);
    expect(released.body()).toEqual({ ok: true, released: true });

    const report = await postBroker("report", {
      leaseId: leased.leaseId,
      ok: true,
      httpStatus: 200,
    });
    expect(report.status()).toBe(404);
    expect(report.body()).toEqual({ ok: false, error: "unknown_lease" });
  });
});
