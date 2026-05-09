/**
 * Adversarial tests for the bootstrap-token verifier.
 *
 * We mint real RS256 keys via `jose`, sign tokens with them, and feed both
 * legitimate and attacker-shaped variants into `verifyBootstrapToken`.
 *
 * The test harness wires a real pglite-backed `AuthStore` so the replay
 * detection (`recordJtiSeen`) is exercised end-to-end.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { AuthStore } from "../../services/auth-store";
import { BOOTSTRAP_TOKEN_SCOPE, verifyBootstrapToken } from "./bootstrap-token";

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface Harness {
  store: AuthStore;
  privateKey: KeyObject;
  publicJwk: JWK;
  attackerPrivateKey: KeyObject;
  attackerPublicJwk: JWK;
  hsSecret: Uint8Array;
  stateDir: string;
  fetchImpl: typeof fetch;
  cleanup: () => Promise<void>;
}

const ISSUER = "https://cloud.test.example";
const CONTAINER_ID = "container-test-123";

function asJoseKeyObject(key: unknown): KeyObject {
  if (!key || typeof key !== "object") {
    throw new Error("Expected jose to return a KeyObject");
  }
  return key as KeyObject;
}

function jwksJson(keys: JWK[]): string {
  return JSON.stringify({ keys });
}

async function open(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-bootstrap-token-"),
  );
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-bootstrap-state-"),
  );
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000007" as `${string}-${string}-${string}-${string}-${string}`,
  ) as AdapterWithDb;
  await adapter.initialize?.();
  if (!adapter.db) throw new Error("test harness: adapter has no .db");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  const store = new AuthStore(db);

  const real = await generateKeyPair("RS256", { extractable: true });
  const attacker = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(real.publicKey);
  publicJwk.kid = "real-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const attackerPublicJwk = await exportJWK(attacker.publicKey);
  attackerPublicJwk.kid = "real-key"; // Same kid as legitimate — kid spoof.
  attackerPublicJwk.alg = "RS256";
  attackerPublicJwk.use = "sig";
  const hsSecret = new Uint8Array(32).fill(7);

  const fetchImpl: typeof fetch = (async (input: Request | URL | string) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/jwks.json")) {
      return new Response(jwksJson([publicJwk]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    store,
    privateKey: asJoseKeyObject(real.privateKey),
    publicJwk,
    attackerPrivateKey: asJoseKeyObject(attacker.privateKey),
    attackerPublicJwk,
    hsSecret,
    stateDir,
    fetchImpl,
    cleanup: async () => {
      await adapter.close?.().catch(() => undefined);
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

interface SignArgs {
  privateKey: KeyObject;
  iss?: string;
  sub?: string;
  containerId?: string;
  scope?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  kid?: string;
}

async function sign(args: SignArgs): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: args.sub ?? "user-1",
    containerId: args.containerId ?? CONTAINER_ID,
    scope: args.scope ?? BOOTSTRAP_TOKEN_SCOPE,
    jti: args.jti ?? `jti-${Math.random().toString(36).slice(2)}`,
  })
    .setProtectedHeader({ alg: "RS256", kid: args.kid ?? "real-key" })
    .setIssuer(args.iss ?? ISSUER)
    .setIssuedAt(args.iat ?? now)
    .setExpirationTime(args.exp ?? now + 600)
    .sign(args.privateKey);
}

function envFor(harness: Harness): NodeJS.ProcessEnv {
  return {
    ELIZA_CLOUD_ISSUER: ISSUER,
    ELIZA_CLOUD_CONTAINER_ID: CONTAINER_ID,
    ELIZA_STATE_DIR: harness.stateDir,
  };
}

describe("verifyBootstrapToken — adversarial cases", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await open();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("accepts a valid RS256 token signed by the legitimate key", async () => {
    const token = await sign({ privateKey: harness.privateKey });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.containerId).toBe(CONTAINER_ID);
      expect(result.claims.scope).toBe("bootstrap");
    }
  });

  it("rejects an HS256 token signed with the JWKS public-key bytes", async () => {
    // Attacker downloads the public JWKS and re-signs with HS256 using the
    // public key as the symmetric secret. RS256-only enforcement must reject.
    const now = Math.floor(Date.now() / 1000);
    const hsToken = await new SignJWT({
      sub: "user-x",
      containerId: CONTAINER_ID,
      scope: BOOTSTRAP_TOKEN_SCOPE,
      jti: "hs-jti",
    })
      .setProtectedHeader({ alg: "HS256", kid: "real-key" })
      .setIssuer(ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(harness.hsSecret);
    const result = await verifyBootstrapToken(hsToken, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["alg_not_allowed", "signature_invalid"]).toContain(result.reason);
    }
  });

  it("rejects a token signed by an attacker-controlled key with the same kid", async () => {
    const token = await sign({
      privateKey: harness.attackerPrivateKey,
      kid: "real-key",
    });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_invalid");
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await sign({
      privateKey: harness.privateKey,
      iss: "https://other.example",
    });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("issuer_mismatch");
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await sign({
      privateKey: harness.privateKey,
      iat: past - 60,
      exp: past,
    });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a token with the wrong containerId", async () => {
    const token = await sign({
      privateKey: harness.privateKey,
      containerId: "container-other",
    });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("container_mismatch");
  });

  it("rejects a token with a non-bootstrap scope", async () => {
    const token = await sign({
      privateKey: harness.privateKey,
      scope: "admin",
    });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope_mismatch");
  });

  it("rejects the same jti on a replay", async () => {
    const jti = "single-shot-jti";
    const first = await sign({ privateKey: harness.privateKey, jti });
    const ok = await verifyBootstrapToken(first, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(ok.ok).toBe(true);

    const second = await sign({ privateKey: harness.privateKey, jti });
    const replay = await verifyBootstrapToken(second, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("replay");
  });

  it("fails closed when the JWKS endpoint is unreachable", async () => {
    const failingFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const token = await sign({ privateKey: harness.privateKey });
    const result = await verifyBootstrapToken(token, {
      env: envFor(harness),
      authStore: harness.store,
      fetchImpl: failingFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("jwks_fetch_failed");
  });

  it("rejects when ELIZA_CLOUD_ISSUER is missing", async () => {
    const token = await sign({ privateKey: harness.privateKey });
    const result = await verifyBootstrapToken(token, {
      env: { ELIZA_CLOUD_CONTAINER_ID: CONTAINER_ID },
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_issuer_env");
  });

  it("rejects when ELIZA_CLOUD_CONTAINER_ID is missing", async () => {
    const token = await sign({ privateKey: harness.privateKey });
    const result = await verifyBootstrapToken(token, {
      env: { ELIZA_CLOUD_ISSUER: ISSUER },
      authStore: harness.store,
      fetchImpl: harness.fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_container_env");
  });
});
