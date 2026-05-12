/**
 * Real-HTTP smoke test for the cloud-provisioned bootstrap exchange.
 *
 * This is the CI gate referenced by the `Auth tests (P0 gate)` job in
 * `.github/workflows/agent-review.yml` and the `smoke-auth` job in
 * `.github/workflows/agent-release.yml`, per
 * `docs/security/remote-auth-hardening-plan.md` §12.
 *
 * It verifies the P0 contract end-to-end without booting the full
 * runtime:
 *
 *   - The audited bypass at `auth-pairing-routes.ts:124,140` /
 *     `server-onboarding-helpers.ts` is closed: `GET /api/onboarding/status`
 *     without auth returns 401 even when `ELIZA_CLOUD_PROVISIONED=1`.
 *   - `POST /api/auth/bootstrap/exchange` with a valid RS256 JWT signed by
 *     the cloud's JWKS returns `{ sessionId, identityId, expiresAt }`.
 *   - The same token cannot be re-used (single-use jti, reason=replay).
 *   - Tampered, wrong-issuer, attacker-signed (same kid), and
 *     wrong-containerId tokens are all rejected with 401.
 *
 * The script generates an RS256 keypair at runtime, serves a fixture
 * JWKS via `node:http`, boots an HTTP server that wires up the real
 * `auth-bootstrap-routes` and `auth-pairing-routes` handlers
 * against a real pglite-backed database, and then drives the contract
 * over real HTTP.
 *
 * The container does not trust any proxy: every token is verified
 * locally by `verifyBootstrapToken`. We assert that here.
 *
 * The private key is generated per process and never written to disk.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  type DrizzleDatabase,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import {
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyObject,
  SignJWT,
} from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSensitiveLimiters } from "./auth/index";
import { handleAuthBootstrapRoutes } from "./auth-bootstrap-routes";
import { handleAuthPairingCompatRoutes } from "./auth-pairing-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

interface DbAdapterLike {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface Harness {
  baseUrl: string;
  containerId: string;
  issuer: string;
  privateKey: KeyObject;
  attackerPrivateKey: KeyObject;
  cleanup: () => Promise<void>;
}

function asJoseKeyObject(key: unknown): KeyObject {
  if (!key || typeof key !== "object") {
    throw new Error("Expected jose to return a KeyObject");
  }
  return key as KeyObject;
}

async function startJwksServer(jwk: JWK): Promise<{
  issuer: string;
  close: () => Promise<void>;
}> {
  const body = JSON.stringify({ keys: [jwk] });
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/.well-known/jwks.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("JWKS server did not bind");
  }
  return {
    issuer: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startApiServer(db: DrizzleDatabase): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  // The route handlers expect `state.current` to be a runtime with an
  // `adapter.db`. The bootstrap exchange route only reads `adapter.db`,
  // so a minimal stub is sufficient for the smoke contract.
  const state: CompatRuntimeState = {
    current: { adapter: { db } } as AgentRuntime,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (await handleAuthBootstrapRoutes(req, res, state)) return;
        if (await handleAuthPairingCompatRoutes(req, res, state)) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (err) {
        console.error("[auth-bootstrap-smoke] handler threw:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        }
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("API server did not bind");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function open(): Promise<Harness> {
  _resetSensitiveLimiters();

  const containerId = `ci-fixture-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-auth-smoke-state-"),
  );
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-auth-smoke-data-"),
  );

  const real = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(real.publicKey);
  publicJwk.kid = "ci-fixture-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const attacker = await generateKeyPair("RS256", { extractable: true });

  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000099" as `${string}-${string}-${string}-${string}-${string}`,
  ) as DbAdapterLike;
  if (typeof adapter.initialize === "function") await adapter.initialize();
  else if (typeof adapter.init === "function") await adapter.init();
  if (!adapter.db) throw new Error("smoke: adapter exposed no .db");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();

  const jwksServer = await startJwksServer(publicJwk);

  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_CLOUD_ISSUER = jwksServer.issuer;
  process.env.ELIZA_CLOUD_CONTAINER_ID = containerId;
  process.env.ELIZA_API_BIND = "127.0.0.1";
  // Loopback bind doesn't strictly require a token, but the plan calls
  // for it to be set so the audited bypass cannot disguise itself
  // behind an open-auth fall-through. The token presence is what makes
  // the unauthenticated `/api/onboarding/status` return 401 instead of
  // 200.
  process.env.ELIZA_API_TOKEN = crypto.randomBytes(24).toString("hex");
  process.env.ELIZA_STATE_DIR = stateDir;

  const api = await startApiServer(db);

  return {
    baseUrl: `http://127.0.0.1:${api.port}`,
    containerId,
    issuer: jwksServer.issuer,
    privateKey: asJoseKeyObject(real.privateKey),
    attackerPrivateKey: asJoseKeyObject(attacker.privateKey),
    cleanup: async () => {
      await api.close();
      await jwksServer.close();
      await adapter.close?.().catch(() => undefined);
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
      delete process.env.ELIZA_CLOUD_PROVISIONED;
      delete process.env.ELIZA_CLOUD_ISSUER;
      delete process.env.ELIZA_CLOUD_CONTAINER_ID;
      delete process.env.ELIZA_API_BIND;
      delete process.env.ELIZA_API_TOKEN;
      delete process.env.ELIZA_STATE_DIR;
    },
  };
}

interface MintArgs {
  privateKey?: KeyObject;
  iss?: string;
  containerId?: string;
  scope?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  sub?: string;
}

async function mint(
  harness: Harness,
  overrides: MintArgs = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: overrides.sub ?? "cloud-user-smoke-1",
    containerId: overrides.containerId ?? harness.containerId,
    scope: overrides.scope ?? "bootstrap",
    jti: overrides.jti ?? `jti-${crypto.randomBytes(8).toString("hex")}`,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "ci-fixture-key" })
    .setIssuer(overrides.iss ?? harness.issuer)
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 600)
    .sign(overrides.privateKey ?? harness.privateKey);
}

describe("cloud-provisioned auth bootstrap smoke (real HTTP)", () => {
  const HARNESS_HOOK_TIMEOUT_MS = 120_000;
  let harness: Harness;

  beforeEach(async () => {
    harness = await open();
  }, HARNESS_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await harness.cleanup();
  });

  it("rejects unauthenticated /api/onboarding/status with 401 (audited bypass closed)", async () => {
    const res = await fetch(`${harness.baseUrl}/api/onboarding/status`);
    // The whole point of P0: cloud-provisioned containers must NOT
    // skip auth on this route. A 200 here is a critical regression.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(401);
  });

  it("accepts a valid bootstrap token and returns sessionId/identityId/expiresAt", async () => {
    const token = await mint(harness);
    const res = await fetch(`${harness.baseUrl}/api/auth/bootstrap/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.sessionId).toBe("string");
    expect(typeof body.identityId).toBe("string");
    expect(typeof body.expiresAt).toBe("number");
    expect((body.sessionId as string).length).toBeGreaterThan(32);
  });

  it("rejects a replayed token with 401 reason=replay", async () => {
    const token = await mint(harness);
    const first = await fetch(
      `${harness.baseUrl}/api/auth/bootstrap/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );
    expect(first.status).toBe(200);

    const replay = await fetch(
      `${harness.baseUrl}/api/auth/bootstrap/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );
    expect(replay.status).toBe(401);
    const replayBody = (await replay.json()) as { reason?: string };
    expect(replayBody.reason).toBe("replay");
  });

  it("rejects a token with a tampered signature", async () => {
    const goodToken = await mint(harness);
    const parts = goodToken.split(".");
    expect(parts).toHaveLength(3);
    const sig = parts[2];
    const flippedChar = sig[0] === "A" ? "B" : "A";
    parts[2] = flippedChar + sig.slice(1);
    const tampered = parts.join(".");
    const res = await fetch(`${harness.baseUrl}/api/auth/bootstrap/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tampered }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await mint(harness, { iss: "https://attacker.example" });
    const res = await fetch(`${harness.baseUrl}/api/auth/bootstrap/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token signed by an attacker key with the same kid", async () => {
    const token = await mint(harness, {
      privateKey: harness.attackerPrivateKey,
    });
    const res = await fetch(`${harness.baseUrl}/api/auth/bootstrap/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token with the wrong containerId", async () => {
    const token = await mint(harness, { containerId: "container-other" });
    const res = await fetch(`${harness.baseUrl}/api/auth/bootstrap/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(401);
  });
});
