/**
 * middleware.test.ts — SEC-132: tenantAuthMiddleware must fail unknown-tenant
 * requests with the same constant-shape 403 as a bad key, and must still run
 * the dummy-hash comparison, so response shape/timing cannot enumerate valid
 * tenant ids.
 *
 * Known-tenant/wrong-key and unknown-tenant responses are byte-identical 403s
 * (status, body, and content type), so requesters cannot enumerate tenant ids.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import { Hono } from "hono";
import { setPGLiteOverride } from "../../../db/src/client.ts";
import { closeDb, getDb, tenants } from "../../../db/src/index.ts";
import { createPGLiteDb } from "../../../db/src/pglite.ts";

import * as apiKeys from "../api-keys";

const TENANT_ID = "sec132-known-tenant";
const ENV_KEYS = [
  "STEWARD_PGLITE_MEMORY",
  "STEWARD_DB_MODE",
  "STEWARD_MASTER_PASSWORD",
] as const;
const UNKNOWN_TENANT_DUMMY_HASH = apiKeys.hashApiKey(
  "steward-unknown-tenant-dummy-key",
);

setDefaultTimeout(30_000);

describe("tenantAuthMiddleware unknown-tenant hardening (SEC-132)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let app: Hono;
  let validKey: string;
  let validateApiKeySpy: ReturnType<typeof spyOn> | undefined;

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.STEWARD_PGLITE_MEMORY = "true";
    process.env.STEWARD_DB_MODE = "pglite";
    process.env.STEWARD_MASTER_PASSWORD ??=
      "sec132-middleware-test-master-password";
    validateApiKeySpy = spyOn(apiKeys, "validateApiKey");
    const { db, client } = await createPGLiteDb("memory://");
    setPGLiteOverride(db, async () => {
      await client.close();
    });

    const keyPair = apiKeys.generateApiKey();
    validKey = keyPair.key;
    await getDb().insert(tenants).values({
      id: TENANT_ID,
      name: "SEC-132 Known Tenant",
      apiKeyHash: keyPair.hash,
    });

    const { tenantAuthMiddleware } = await import("../middleware");
    app = new Hono();
    app.use("*", tenantAuthMiddleware());
    app.get("/", (c) => c.json({ ok: true }));
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/probe", (c) => c.json({ ok: true }));
  });

  afterAll(async () => {
    try {
      await closeDb();
    } finally {
      try {
        validateApiKeySpy?.mockRestore();
      } finally {
        for (const key of ENV_KEYS) {
          if (savedEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = savedEnv[key];
          }
        }
      }
    }
  });

  async function probe(tenantId: string, key: string): Promise<Response> {
    return app.request("/probe", {
      headers: { "X-Steward-Tenant": tenantId, "X-Steward-Key": key },
    });
  }

  it("admits a known tenant with its valid key", async () => {
    const res = await probe(TENANT_ID, validKey);
    expect(res.status).toBe(200);
  });

  it("rejects an unknown tenant with a constant-shape 403 identical to a bad key", async () => {
    const knownBadKeyRes = await probe(TENANT_ID, "stw_wrong_key");
    expect(knownBadKeyRes.status).toBe(403);
    const knownBadKeyBody = await knownBadKeyRes.json();

    const unknownTenantRes = await probe(
      "sec132-no-such-tenant",
      "stw_wrong_key",
    );
    expect(unknownTenantRes.status).toBe(403);
    const unknownTenantBody = await unknownTenantRes.json();

    // Constant shape: identical status, body, and content type whether the
    // tenant id exists or not — no enumeration signal in the response.
    expect(unknownTenantBody).toEqual(knownBadKeyBody);
    expect(unknownTenantBody).toEqual({ ok: false, error: "Invalid API key" });
    expect(unknownTenantRes.headers.get("content-type")).toBe(
      knownBadKeyRes.headers.get("content-type"),
    );
    expect(validateApiKeySpy).toHaveBeenCalledWith(
      "stw_wrong_key",
      UNKNOWN_TENANT_DUMMY_HASH,
    );
  });

  it("keeps the healthcheck bypass exact: GET / and /health only", async () => {
    // No auth headers at all — the bypass serves these without a tenant.
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/health")).status).toBe(200);
    // Non-healthcheck paths and non-GET methods stay authenticated.
    expect((await app.request("/probe")).status).toBe(401);
    expect((await app.request("/", { method: "POST" })).status).toBe(401);
  });
});
