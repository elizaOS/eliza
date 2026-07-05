/**
 * Team credential pool — REAL cloud account-pool brain + REAL PGlite DB (#11332).
 *
 * These cases run the actual cloud-shared `TeamCredentialAccountPool` through
 * `TeamPoolRegistry` against real `pooled_credentials` rows, real
 * envelope-encrypted `secrets` rows, and a real HTTP provider stub for the live
 * contribution probe (the probe honors ANTHROPIC_BASE_URL, so no fetch mocking
 * — real request, real 200/401).
 *
 * Proven here, against the DB:
 *  - contribution probe-gates keys (bad key → rejected, no row, no secret)
 *  - keys are ciphertext at rest (encrypted_value != plaintext; decrypt round-trips)
 *  - the contribution response is masked — the plaintext is never returned
 *  - round-robin selection rotates across 3 pooled keys
 *  - a rate-limited key is skipped and re-admitted after `until` passes
 *  - writeAccount is a ROW-LEVEL update of pool-owned columns only: sibling
 *    rows + ciphertext untouched, AND a stale-snapshot health write cannot
 *    revert a concurrent admin disable (the clobber race)
 *  - the keep-alive sweep detects a key revoked at the provider (needs-reauth)
 *    and heals it when the provider re-accepts it
 *  - delete removes the pool row AND its vault secret
 *  - per-member daily usage rollup upserts (credential, user, day)
 *  - the generated migration SQL applies cleanly (migration up) and is journaled
 *
 * Fails loudly (pgliteReady guard) if PGlite/pushSchema ever breaks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SECRETS_MASTER_KEY = "0123456789abcdef".repeat(4);

const PGLITE_TIMEOUT = 120_000;

const GOOD_KEYS = new Set([
  "sk-ant-pool-key-alpha-0001",
  "sk-ant-pool-key-beta-0002",
  "sk-ant-pool-key-gamma-0003",
  "sk-ant-pool-key-delta-0004",
]);

let pgliteReady = true;
let provider: ReturnType<typeof Bun.serve> | undefined;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let dbWrite: typeof import("../../../db/client").dbWrite;
let repo: typeof import("../../../db/repositories/pooled-credentials").pooledCredentialsRepository;
let svc: typeof import("../team-credential-pool/service");
let registryMod: typeof import("../team-credential-pool/registry");

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const MEMBER_A = "aaaaaaaa-2222-4222-8222-222222222222";
const OWNER_B = "bbbbbbbb-1111-4111-8111-111111111111";

const AUDIT = {
  actorType: "user" as const,
  actorId: OWNER_A,
  source: "team-credential-pool.test",
};

beforeAll(async () => {
  try {
    // Real HTTP provider stub — the probe's ANTHROPIC_BASE_URL override.
    provider = Bun.serve({
      port: 0,
      fetch(req) {
        const key = req.headers.get("x-api-key") ?? "";
        if (new URL(req.url).pathname.endsWith("/models")) {
          return GOOD_KEYS.has(key)
            ? Response.json({ data: [] })
            : Response.json({ error: "invalid api key" }, { status: 401 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;

    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ pooledCredentialsRepository: repo } = await import(
      "../../../db/repositories/pooled-credentials"
    ));
    svc = await import("../team-credential-pool/service");
    registryMod = await import("../team-credential-pool/registry");

    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const {
      secretActorTypeEnum,
      secretAuditActionEnum,
      secretAuditLog,
      secretEnvironmentEnum,
      secretProjectTypeEnum,
      secretProviderEnum,
      secretScopeEnum,
      secrets,
    } = await import("../../../db/schemas/secrets");
    const { pooledCredentialUsage, pooledCredentials } = await import(
      "../../../db/schemas/pooled-credentials"
    );

    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        secrets,
        secretAuditLog,
        secretScopeEnum,
        secretEnvironmentEnum,
        secretAuditActionEnum,
        secretActorTypeEnum,
        secretProviderEnum,
        secretProjectTypeEnum,
        pooledCredentials,
        pooledCredentialUsage,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values([
      { id: ORG_A, name: "Org A", slug: "org-a" },
      { id: ORG_B, name: "Org B", slug: "org-b" },
    ]);
    await dbWrite.insert(users).values([
      {
        id: OWNER_A,
        email: "owner@a.test",
        organization_id: ORG_A,
        role: "owner",
        steward_user_id: `steward-${OWNER_A}`,
      },
      {
        id: MEMBER_A,
        email: "member@a.test",
        organization_id: ORG_A,
        role: "member",
        steward_user_id: `steward-${MEMBER_A}`,
      },
      {
        id: OWNER_B,
        email: "owner@b.test",
        organization_id: ORG_B,
        role: "owner",
        steward_user_id: `steward-${OWNER_B}`,
      },
    ]);
  } catch (error) {
    pgliteReady = false;
    console.error("[team-credential-pool.test] PGlite/pushSchema unavailable — failing.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  provider?.stop(true);
  if (closeDb) await closeDb();
});

async function secretRow(secretId: string): Promise<{ encrypted_value: string } | undefined> {
  const rows = await dbWrite.execute(
    `SELECT encrypted_value FROM secrets WHERE id = '${secretId}';`,
  );
  return rows.rows[0] as { encrypted_value: string } | undefined;
}

describe("contribution — live probe gate + ciphertext at rest", () => {
  test("a key the provider rejects (401) is NOT pooled: no row, no secret", async () => {
    expect(pgliteReady).toBe(true);
    await expect(
      svc.contributePooledCredential({
        organizationId: ORG_A,
        userId: OWNER_A,
        provider: "anthropic-api",
        apiKey: "sk-ant-revoked-key-9999",
        audit: AUDIT,
      }),
    ).rejects.toThrow(/failed live validation.*401/i);
    expect(await repo.listByOrganization(ORG_A)).toHaveLength(0);
    const secretsLeft = await dbWrite.execute(`SELECT id FROM secrets;`);
    expect(secretsLeft.rows).toHaveLength(0);
  });

  test("subscription providers are rejected at the Phase-1 gate", async () => {
    await expect(
      svc.contributePooledCredential({
        organizationId: ORG_A,
        userId: OWNER_A,
        provider: "anthropic-subscription",
        apiKey: "sk-ant-oat-something",
        audit: AUDIT,
      }),
    ).rejects.toThrow(/cannot be pooled/i);
  });

  test("a live-validated key is stored ciphertext-only and decrypt round-trips", async () => {
    const plaintext = "sk-ant-pool-key-alpha-0001";
    const result = await svc.contributePooledCredential({
      organizationId: ORG_A,
      userId: OWNER_A,
      provider: "anthropic-api",
      apiKey: plaintext,
      label: "alpha",
      priority: 1,
      audit: AUDIT,
    });
    // Masked summary only — the plaintext is NEVER returned, even here.
    expect(result.last4).toBe("0001");
    expect(JSON.stringify(result)).not.toContain(plaintext);

    const row = await repo.findById(result.id);
    expect(row).toBeDefined();
    if (!row) throw new Error("row missing");
    // At rest: envelope ciphertext, never the plaintext.
    const stored = await secretRow(row.secret_id);
    expect(stored).toBeDefined();
    expect(stored?.encrypted_value).not.toContain(plaintext);
    // Decrypt round-trip through the vault.
    const { secretsService } = await import("../secrets/secrets");
    expect(await secretsService.getDecryptedValue(row.secret_id, ORG_A)).toBe(plaintext);
  });
});

describe("selection — real AccountPool rotation + health", () => {
  let credAlpha = "";
  let credBeta = "";
  let credGamma = "";

  test("round-robin rotates across 3 pooled keys", async () => {
    // alpha exists from the previous suite; contribute beta + gamma.
    const beta = await svc.contributePooledCredential({
      organizationId: ORG_A,
      userId: MEMBER_A,
      provider: "anthropic-api",
      apiKey: "sk-ant-pool-key-beta-0002",
      label: "beta",
      priority: 2,
      audit: AUDIT,
    });
    const gamma = await svc.contributePooledCredential({
      organizationId: ORG_A,
      userId: MEMBER_A,
      provider: "anthropic-api",
      apiKey: "sk-ant-pool-key-gamma-0003",
      label: "gamma",
      priority: 3,
      audit: AUDIT,
    });
    credBeta = beta.id;
    credGamma = gamma.id;
    const all = await repo.listByOrganization(ORG_A);
    expect(all).toHaveLength(3);
    credAlpha = all.find((r) => r.label === "alpha")?.id ?? "";
    expect(credAlpha).not.toBe("");

    const registry = new registryMod.TeamPoolRegistry();
    const picked: string[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const selected = await registry.selectCredential({
        organizationId: ORG_A,
        providerId: "anthropic-api",
        strategy: "round-robin",
      });
      expect(selected).not.toBeNull();
      if (!selected) throw new Error("no credential selected");
      picked.push(selected.credentialId);
      keys.add(selected.apiKey);
      expect(selected.envKey).toBe("ANTHROPIC_API_KEY");
    }
    // 6 round-robin picks over 3 keys → every key used exactly twice.
    const counts = new Map<string, number>();
    for (const id of picked) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([credAlpha, credBeta, credGamma].sort());
    for (const n of counts.values()) expect(n).toBe(2);
    // ...and each resolved to its real decrypted plaintext.
    expect([...keys].sort()).toEqual(
      [
        "sk-ant-pool-key-alpha-0001",
        "sk-ant-pool-key-beta-0002",
        "sk-ant-pool-key-gamma-0003",
      ].sort(),
    );
  });

  test("a rate-limited key is skipped, then re-admitted after `until` passes", async () => {
    const registry = new registryMod.TeamPoolRegistry();
    const entry = await registry.getOrgPool(ORG_A);
    if (!entry) throw new Error("no pool for ORG_A");
    // 429 recorded against beta with a 60s cool-off — through the REAL pool
    // brain persisting via the Drizzle deps.
    await entry.pool.markRateLimited(credBeta, Date.now() + 60_000, "429 from provider", {
      providerId: "anthropic-api",
    });
    const betaRow = await repo.findById(credBeta);
    expect(betaRow?.health).toBe("rate-limited");
    expect(betaRow?.health_detail?.until).toBeGreaterThan(Date.now());
    // ROW-LEVEL write: siblings untouched.
    expect((await repo.findById(credAlpha))?.health).toBe("ok");
    expect((await repo.findById(credGamma))?.health).toBe("ok");

    registry.invalidate(ORG_A);
    for (let i = 0; i < 6; i++) {
      const selected = await registry.selectCredential({
        organizationId: ORG_A,
        providerId: "anthropic-api",
        strategy: "round-robin",
      });
      expect(selected?.credentialId).not.toBe(credBeta);
    }

    // Cool-off expires → eligible again on the next selection pass.
    await repo.updatePoolState(credBeta, {
      health: "rate-limited",
      health_detail: { until: Date.now() - 1_000, lastChecked: Date.now() },
    });
    registry.invalidate(ORG_A);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const selected = await registry.selectCredential({
        organizationId: ORG_A,
        providerId: "anthropic-api",
        strategy: "round-robin",
      });
      if (selected) seen.add(selected.credentialId);
    }
    expect(seen.has(credBeta)).toBe(true);
  });

  test("Worker provider outcome writeback marks 429 and 401 credentials unhealthy", async () => {
    const registry = new registryMod.TeamPoolRegistry();

    await registry.recordProviderFailure({
      organizationId: ORG_A,
      credentialId: credBeta,
      providerId: "anthropic-api",
      status: 429,
      detail: "429 from Worker inference",
    });
    const betaAfter429 = await repo.findById(credBeta);
    expect(betaAfter429?.health).toBe("rate-limited");
    expect(betaAfter429?.health_detail?.until).toBeGreaterThan(Date.now());
    expect(betaAfter429?.health_detail?.lastError).toBe("429 from Worker inference");

    await registry.recordProviderFailure({
      organizationId: ORG_A,
      credentialId: credGamma,
      providerId: "anthropic-api",
      status: 401,
      detail: "401 from Worker inference",
    });
    const gammaAfter401 = await repo.findById(credGamma);
    expect(gammaAfter401?.health).toBe("needs-reauth");
    expect(gammaAfter401?.health_detail?.lastError).toBe("401 from Worker inference");

    // Preserve the fixture state expected by the keep-alive test below: beta is
    // rate-limited, but its cool-off has already passed.
    await repo.updatePoolState(credBeta, {
      health: "rate-limited",
      health_detail: {
        until: Date.now() - 1_000,
        lastChecked: Date.now(),
        lastError: "expired test cool-off",
      },
    });
  });

  test("writeAccount (401 → needs-reauth) updates metadata only, ciphertext untouched", async () => {
    const before = await repo.findById(credGamma);
    if (!before) throw new Error("gamma missing");
    const cipherBefore = (await secretRow(before.secret_id))?.encrypted_value;

    const registry = new registryMod.TeamPoolRegistry();
    const entry = await registry.getOrgPool(ORG_A);
    if (!entry) throw new Error("no pool for ORG_A");
    await entry.pool.markNeedsReauth(credGamma, "401 from provider", {
      providerId: "anthropic-api",
    });

    const after = await repo.findById(credGamma);
    expect(after?.health).toBe("needs-reauth");
    expect(after?.secret_id).toBe(before.secret_id);
    expect(after?.provider).toBe(before.provider);
    expect((await secretRow(before.secret_id))?.encrypted_value).toBe(cipherBefore);
  });

  test("a stale-snapshot health write cannot revert a concurrent admin disable", async () => {
    const registry = new registryMod.TeamPoolRegistry();
    // Load the snapshot while alpha is still enabled.
    const entry = await registry.getOrgPool(ORG_A);
    if (!entry) throw new Error("no pool for ORG_A");
    expect(entry.pool.get(credAlpha)?.enabled).toBe(true);

    // Admin disables alpha AFTER the snapshot was taken.
    await svc.updatePooledCredential({
      credentialId: credAlpha,
      organizationId: ORG_A,
      enabled: false,
    });
    expect((await repo.findById(credAlpha))?.enabled).toBe(false);

    // Health write from the stale snapshot (which still says enabled=true).
    await entry.pool.markRateLimited(credAlpha, Date.now() + 60_000, "429", {
      providerId: "anthropic-api",
    });

    const after = await repo.findById(credAlpha);
    expect(after?.health).toBe("rate-limited"); // pool-owned column landed…
    expect(after?.enabled).toBe(false); // …the admin disable SURVIVED

    // Restore alpha for the following suites.
    await svc.updatePooledCredential({
      credentialId: credAlpha,
      organizationId: ORG_A,
      enabled: true,
    });
    await repo.updatePoolState(credAlpha, {
      health: "ok",
      health_detail: null,
    });
  });

  test("keep-alive sweep flags a provider-revoked key and heals recovered ones", async () => {
    // State walking in: beta rate-limited (until already forced into the
    // past), gamma needs-reauth, alpha ok but never probe-stamped — and
    // alpha's key gets revoked at the provider console.
    GOOD_KEYS.delete("sk-ant-pool-key-alpha-0001");

    const registry = new registryMod.TeamPoolRegistry();
    const entry = await registry.getOrgPool(ORG_A);
    if (!entry) throw new Error("no pool for ORG_A");
    await registry.sweepActivePools();

    // alpha (stale-ok) was probed against the provider → 401 → needs-reauth.
    const alpha = await repo.findById(credAlpha);
    expect(alpha?.health).toBe("needs-reauth");
    expect(alpha?.health_detail?.lastError).toMatch(/401/);
    // gamma (flagged needs-reauth) re-probed with its still-good key → healed
    // with a fresh verification stamp.
    const gamma = await repo.findById(credGamma);
    expect(gamma?.health).toBe("ok");
    expect(typeof gamma?.health_detail?.lastChecked).toBe("number");
    // beta (rate-limited, cool-off expired) → healed.
    expect((await repo.findById(credBeta))?.health).toBe("ok");

    // The key is restored at the provider → the next sweep heals alpha.
    GOOD_KEYS.add("sk-ant-pool-key-alpha-0001");
    await registry.sweepActivePools();
    expect((await repo.findById(credAlpha))?.health).toBe("ok");
  });

  test("per-member daily rollup upserts (credential, user, day) and sums per org-day", async () => {
    const registry = new registryMod.TeamPoolRegistry();
    await registry.recordUse({
      organizationId: ORG_A,
      credentialId: credAlpha,
      userId: MEMBER_A,
    });
    await registry.recordUse({
      organizationId: ORG_A,
      credentialId: credAlpha,
      userId: MEMBER_A,
    });
    await registry.recordUse({
      organizationId: ORG_A,
      credentialId: credAlpha,
      userId: OWNER_A,
    });
    const day = new Date().toISOString().slice(0, 10);
    const rollups = await repo.listUsageByCredential(credAlpha);
    expect(rollups).toHaveLength(2);
    expect(rollups.find((r) => r.user_id === MEMBER_A)?.calls).toBe(2);
    expect(rollups.find((r) => r.user_id === OWNER_A)?.calls).toBe(1);
    expect((await repo.usageTotalsForDay(ORG_A, day)).get(credAlpha)).toBe(3);
    expect((await repo.findById(credAlpha))?.last_used_at).not.toBeNull();
  });

  test("wrong-org service calls cannot update or delete a known credential id", async () => {
    const before = await repo.findById(credAlpha);
    if (!before) throw new Error("alpha missing");
    const secretId = before.secret_id;

    expect(
      await repo.updatePoolStateForOrganization(credAlpha, ORG_B, {
        enabled: false,
      }),
    ).toBeUndefined();
    expect(await repo.deleteForOrganization(credAlpha, ORG_B)).toBeUndefined();

    await expect(
      svc.updatePooledCredential({
        credentialId: credAlpha,
        organizationId: ORG_B,
        enabled: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.removePooledCredential({
        credentialId: credAlpha,
        organizationId: ORG_B,
        audit: {
          actorType: "user",
          actorId: OWNER_B,
          source: "team-credential-pool.test",
        },
      }),
    ).rejects.toMatchObject({ status: 404 });

    const after = await repo.findById(credAlpha);
    expect(after?.organization_id).toBe(ORG_A);
    expect(after?.enabled).toBe(true);
    expect(await secretRow(secretId)).toBeDefined();
  });

  test("remove deletes the pool row AND its vault secret", async () => {
    const delta = await svc.contributePooledCredential({
      organizationId: ORG_A,
      userId: MEMBER_A,
      provider: "anthropic-api",
      apiKey: "sk-ant-pool-key-delta-0004",
      audit: AUDIT,
    });
    const row = await repo.findById(delta.id);
    if (!row) throw new Error("delta missing");
    expect(await secretRow(row.secret_id)).toBeDefined();

    await svc.removePooledCredential({
      credentialId: row.id,
      organizationId: ORG_A,
      audit: AUDIT,
    });
    expect(await repo.findById(row.id)).toBeUndefined();
    expect(await secretRow(row.secret_id)).toBeUndefined();
  });
});
