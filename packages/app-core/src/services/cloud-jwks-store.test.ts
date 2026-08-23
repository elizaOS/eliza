/**
 * Real-disk unit tests for the cloud JWKS cache: state-dir path resolution,
 * write envelope, issuer/TTL gating, and fail-closed parse of malformed
 * cache files. Drives the exported store through a temp `ELIZA_STATE_DIR`;
 * the network fetch lives in the bootstrap-token verifier, not here.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_JWKS_TTL_MS,
  type JwksDocument,
  type JwksKey,
  readCachedJwks,
  resolveElizaStateDir,
  resolveJwksCachePath,
  writeCachedJwks,
} from "./cloud-jwks-store";

const ISSUER = "https://cloud.test.example";
const OTHER_ISSUER = "https://other.example";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function openStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cloud-jwks-store-"));
  tempDirs.push(dir);
  return dir;
}

function envFor(stateDir: string): { ELIZA_STATE_DIR: string } {
  return { ELIZA_STATE_DIR: stateDir };
}

function rsaKey(kid = "k1"): JwksKey {
  return {
    kty: "RSA",
    kid,
    use: "sig",
    alg: "RS256",
    n: "modulus",
    e: "AQAB",
  };
}

function jwksWith(...keys: JwksKey[]): JwksDocument {
  return { keys };
}

async function plantCache(stateDir: string, raw: string): Promise<string> {
  const filePath = resolveJwksCachePath(envFor(stateDir));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, raw, "utf8");
  return filePath;
}

describe("DEFAULT_JWKS_TTL_MS", () => {
  it("is six hours in milliseconds", () => {
    expect(DEFAULT_JWKS_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("resolveElizaStateDir", () => {
  it("honours ELIZA_STATE_DIR over XDG state home", () => {
    const resolved = resolveElizaStateDir({
      ELIZA_STATE_DIR: "/explicit/state",
      XDG_STATE_HOME: "/xdg/state",
    });
    expect(resolved).toBe(path.resolve("/explicit/state"));
  });

  it("falls back to XDG_STATE_HOME/<namespace> when ELIZA_STATE_DIR is absent", () => {
    const resolved = resolveElizaStateDir({
      XDG_STATE_HOME: "/xdg/state",
    });
    expect(resolved).toBe(path.join("/xdg/state", "eliza"));
  });

  it("uses ELIZA_NAMESPACE under XDG_STATE_HOME", () => {
    const resolved = resolveElizaStateDir({
      XDG_STATE_HOME: "/xdg/state",
      ELIZA_NAMESPACE: "custom-ns",
    });
    expect(resolved).toBe(path.join("/xdg/state", "custom-ns"));
  });

  it("defaults to ~/.local/state/eliza when neither override is set", () => {
    expect(resolveElizaStateDir({})).toBe(
      path.join(homedir(), ".local", "state", "eliza"),
    );
  });
});

describe("resolveJwksCachePath", () => {
  it("places the cache at <state>/auth/cloud-jwks.json", async () => {
    const stateDir = await openStateDir();
    expect(resolveJwksCachePath(envFor(stateDir))).toBe(
      path.join(stateDir, "auth", "cloud-jwks.json"),
    );
  });
});

describe("writeCachedJwks / readCachedJwks", () => {
  it("round-trips a JWKS document for the matching issuer", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const doc = jwksWith(rsaKey("unit-key"));
    await writeCachedJwks(ISSUER, doc, { env, now: 1_700_000_000_000 });

    const hit = await readCachedJwks(ISSUER, {
      env,
      now: 1_700_000_000_000,
    });
    expect(hit).toEqual(doc);
  });

  it("writes a pretty-printed envelope with a trailing newline", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const doc = jwksWith(rsaKey());
    const now = 42;
    await writeCachedJwks(ISSUER, doc, { env, now });

    const raw = readFileSync(resolveJwksCachePath(env), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toBe(
      `${JSON.stringify(
        { fetchedAt: now, issuer: ISSUER, jwks: doc },
        null,
        2,
      )}\n`,
    );
  });

  it("creates the auth directory with mode 0700 and the cache file with mode 0600", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    await writeCachedJwks(ISSUER, jwksWith(rsaKey()), { env, now: 1 });

    const filePath = resolveJwksCachePath(env);
    const fileMode = statSync(filePath).mode & 0o777;
    const dirMode = statSync(path.dirname(filePath)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("overwrites a previous envelope for a later write", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    await writeCachedJwks(ISSUER, jwksWith(rsaKey("old")), { env, now: 10 });
    const replacement = jwksWith(rsaKey("new"), rsaKey("second"));
    await writeCachedJwks(OTHER_ISSUER, replacement, { env, now: 20 });

    expect(await readCachedJwks(ISSUER, { env, now: 20 })).toBeNull();
    expect(await readCachedJwks(OTHER_ISSUER, { env, now: 20 })).toEqual(
      replacement,
    );
  });

  it("returns null when the cache file is missing", async () => {
    const stateDir = await openStateDir();
    expect(await readCachedJwks(ISSUER, { env: envFor(stateDir) })).toBeNull();
  });

  it("returns null when the cached issuer does not match", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    await writeCachedJwks(ISSUER, jwksWith(rsaKey()), { env, now: 100 });
    expect(await readCachedJwks(OTHER_ISSUER, { env, now: 100 })).toBeNull();
  });

  it("treats an issuer with a trailing slash as a different issuer", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    await writeCachedJwks(ISSUER, jwksWith(rsaKey()), { env, now: 100 });
    expect(await readCachedJwks(`${ISSUER}/`, { env, now: 100 })).toBeNull();
  });

  it("returns the document when age equals ttlMs (expiry uses strictly greater-than)", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const ttlMs = 1_000;
    const fetchedAt = 5_000;
    await writeCachedJwks(ISSUER, jwksWith(rsaKey()), {
      env,
      now: fetchedAt,
    });
    expect(
      await readCachedJwks(ISSUER, {
        env,
        now: fetchedAt + ttlMs,
        ttlMs,
      }),
    ).toEqual(jwksWith(rsaKey()));
  });

  it("returns null when age is one millisecond past ttlMs", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const ttlMs = 1_000;
    const fetchedAt = 5_000;
    await writeCachedJwks(ISSUER, jwksWith(rsaKey()), {
      env,
      now: fetchedAt,
    });
    expect(
      await readCachedJwks(ISSUER, {
        env,
        now: fetchedAt + ttlMs + 1,
        ttlMs,
      }),
    ).toBeNull();
  });

  it("uses DEFAULT_JWKS_TTL_MS when ttlMs is omitted", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const fetchedAt = 10_000;
    await writeCachedJwks(ISSUER, jwksWith(rsaKey()), {
      env,
      now: fetchedAt,
    });
    expect(
      await readCachedJwks(ISSUER, {
        env,
        now: fetchedAt + DEFAULT_JWKS_TTL_MS,
      }),
    ).toEqual(jwksWith(rsaKey()));
    expect(
      await readCachedJwks(ISSUER, {
        env,
        now: fetchedAt + DEFAULT_JWKS_TTL_MS + 1,
      }),
    ).toBeNull();
  });

  it("round-trips an empty keys array", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const empty: JwksDocument = { keys: [] };
    await writeCachedJwks(ISSUER, empty, { env, now: 1 });
    expect(await readCachedJwks(ISSUER, { env, now: 1 })).toEqual(empty);
  });

  it("round-trips extra string properties on a key", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const doc = jwksWith({ ...rsaKey(), x5t: "thumbprint" });
    await writeCachedJwks(ISSUER, doc, { env, now: 1 });
    expect(await readCachedJwks(ISSUER, { env, now: 1 })).toEqual(doc);
  });

  it("throws when the cache path exists but is not a file", async () => {
    const stateDir = await openStateDir();
    const env = envFor(stateDir);
    const filePath = resolveJwksCachePath(env);
    await mkdir(filePath, { recursive: true });
    await expect(readCachedJwks(ISSUER, { env })).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});

describe("readCachedJwks malformed envelope", () => {
  it("returns null for invalid JSON", async () => {
    const stateDir = await openStateDir();
    await plantCache(stateDir, "{not-json");
    expect(await readCachedJwks(ISSUER, { env: envFor(stateDir) })).toBeNull();
  });

  it("returns null for a JSON array", async () => {
    const stateDir = await openStateDir();
    await plantCache(stateDir, "[]");
    expect(await readCachedJwks(ISSUER, { env: envFor(stateDir) })).toBeNull();
  });

  it("returns null for a JSON primitive", async () => {
    const stateDir = await openStateDir();
    await plantCache(stateDir, "null");
    expect(await readCachedJwks(ISSUER, { env: envFor(stateDir) })).toBeNull();
  });

  it("returns null when fetchedAt is missing", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({ issuer: ISSUER, jwks: jwksWith(rsaKey()) }),
    );
    expect(await readCachedJwks(ISSUER, { env: envFor(stateDir) })).toBeNull();
  });

  it("returns null when fetchedAt is null", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({
        fetchedAt: null,
        issuer: ISSUER,
        jwks: jwksWith(rsaKey()),
      }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });

  it("returns null when fetchedAt is a string", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({
        fetchedAt: "1700000000000",
        issuer: ISSUER,
        jwks: jwksWith(rsaKey()),
      }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });

  it("returns null when issuer is missing", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({ fetchedAt: 1, jwks: jwksWith(rsaKey()) }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });

  it("returns null when jwks.keys is not an array", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({
        fetchedAt: 1,
        issuer: ISSUER,
        jwks: { keys: { kty: "RSA" } },
      }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });

  it("returns null when a key is missing kty", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({
        fetchedAt: 1,
        issuer: ISSUER,
        jwks: { keys: [{ kid: "no-kty" }] },
      }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });

  it("returns null when any key in the array is invalid", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({
        fetchedAt: 1,
        issuer: ISSUER,
        jwks: { keys: [rsaKey(), { kid: "bad" }] },
      }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });

  it("returns null when a key is a primitive", async () => {
    const stateDir = await openStateDir();
    await plantCache(
      stateDir,
      JSON.stringify({
        fetchedAt: 1,
        issuer: ISSUER,
        jwks: { keys: ["RSA"] },
      }),
    );
    expect(
      await readCachedJwks(ISSUER, { env: envFor(stateDir), now: 1 }),
    ).toBeNull();
  });
});
