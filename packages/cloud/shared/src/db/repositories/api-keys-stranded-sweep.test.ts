/**
 * Real-DB (PGlite) coverage for the stranded agent-sandbox key GC query (#16071).
 *
 * `deleteOlderThan(olderThan)` must delete only active
 * `agent-sandbox:<uuid>` keys whose uuid has NO `agent_sandboxes` row and whose
 * `created_at` predates the grace window. The three acceptance cases from the
 * issue are proven against real SQL (no mocks): a stranded key is returned, an
 * in-flight (young) mint is protected by the grace window, and a key correctly
 * bound to a live sandbox is never returned. PGlite setup is intentionally not
 * swallowed, so a broken backend cannot vacuously pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

let dbWrite: typeof import("../helpers").dbWrite;
let apiKeysRepository: typeof import("./api-keys").apiKeysRepository;
let strandedAgentKeyRepository: typeof import("./stranded-agent-keys").strandedAgentKeyRepository;
let closeDatabaseConnectionsForTests: typeof import("../client").closeDatabaseConnectionsForTests;

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";

// Sandbox ids the tests reference. LIVE has a matching agent_sandboxes row.
const SANDBOX_STRANDED = "00000000-0000-4000-8000-0000000000c1";
const SANDBOX_LIVE = "00000000-0000-4000-8000-0000000000c2";
const SANDBOX_INFLIGHT = "00000000-0000-4000-8000-0000000000c3";

let hashCounter = 0;

async function insertKey(params: {
  name: string;
  isActive?: boolean;
  createdAtSql: string;
}): Promise<string> {
  hashCounter += 1;
  const hash = `hash-${hashCounter}-${params.name}`;
  const result = (await dbWrite.execute(sql`
    INSERT INTO api_keys (name, key_hash, key_prefix, organization_id, user_id, is_active, created_at)
    VALUES (
      ${params.name},
      ${hash},
      'eliza_pref',
      ${ORG_ID},
      ${USER_ID},
      ${params.isActive ?? true},
      ${sql.raw(params.createdAtSql)}
    )
    RETURNING id
  `)) as { rows: Array<{ id: string }> };
  return result.rows[0].id;
}

beforeAll(async () => {
  ({ dbWrite } = await import("../helpers"));
  ({ closeDatabaseConnectionsForTests } = await import("../client"));
  ({ apiKeysRepository } = await import("./api-keys"));
  ({ strandedAgentKeyRepository } = await import("./stranded-agent-keys"));

  // Minimal shapes: the query only touches api_keys columns + agent_sandboxes.id.
  await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS agent_sandboxes (
        id uuid PRIMARY KEY
      )
    `);
  await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        description text,
        key_hash text NOT NULL UNIQUE,
        key_prefix text NOT NULL,
        key_ciphertext text, key_nonce text, key_auth_tag text,
        key_kms_key_id text, key_kms_key_version integer,
        organization_id uuid NOT NULL,
        user_id uuid NOT NULL,
        source_app_id uuid,
        rate_limit integer NOT NULL DEFAULT 1000,
        is_active boolean NOT NULL DEFAULT true,
        usage_count integer NOT NULL DEFAULT 0,
        expires_at timestamp,
        last_used_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        deleted_at timestamp
      )
    `);
});

describe("ApiKeysRepository mobile credential boundaries", () => {
  async function insertMobileKey(params: {
    id: string;
    keyHash: string;
    sourceAppId: string;
    userId?: string;
    organizationId?: string;
    isActive?: boolean;
    deletedAtSql?: string | null;
  }): Promise<void> {
    await dbWrite.execute(sql`
      INSERT INTO api_keys (
        id, name, key_hash, key_prefix, key_ciphertext, key_nonce,
        key_auth_tag, key_kms_key_id, key_kms_key_version,
        organization_id, user_id, source_app_id, is_active, deleted_at, created_at
      )
      VALUES (
        ${params.id},
        ${`mobile-${params.id}`},
        ${params.keyHash},
        'eliza_mobile',
        'ciphertext',
        'nonce',
        'auth-tag',
        'kms-key',
        3,
        ${params.organizationId ?? ORG_ID},
        ${params.userId ?? USER_ID},
        ${params.sourceAppId},
        ${params.isActive ?? true},
        ${params.deletedAtSql === undefined ? null : sql.raw(params.deletedAtSql ?? "NULL")},
        now()
      )
    `);
  }

  test("generic management reads and writes ignore mobile-owned credentials", async () => {
    const ordinaryId = await insertKey({
      name: "ordinary-settings-key",
      createdAtSql: "now()",
    });
    const mobileId = "11111111-1111-4111-8111-111111111111";
    await insertMobileKey({
      id: mobileId,
      keyHash: "m".repeat(64),
      sourceAppId: "22222222-2222-4222-8222-222222222222",
    });

    await expect(apiKeysRepository.findManageableById(ordinaryId)).resolves.toMatchObject({
      id: ordinaryId,
    });
    await expect(apiKeysRepository.findManageableById(mobileId)).resolves.toBeUndefined();
    await expect(apiKeysRepository.listByOrganization(ORG_ID)).resolves.toEqual([
      expect.objectContaining({ id: ordinaryId }),
    ]);

    await expect(
      apiKeysRepository.update(mobileId, { name: "should-not-update" }),
    ).resolves.toBeUndefined();
    await apiKeysRepository.delete(mobileId);
    await expect(apiKeysRepository.findByIdConsistent(mobileId)).resolves.toMatchObject({
      id: mobileId,
      source_app_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("ordinary key reads, active filtering, updates, and deactivation use real rows", async () => {
    const activeId = await insertKey({
      name: "ordinary-active-key",
      createdAtSql: "now()",
    });
    const expiredId = await insertKey({
      name: "ordinary-expired-key",
      createdAtSql: "now() - interval '2 days'",
    });
    await dbWrite.execute(sql`
      UPDATE api_keys
      SET expires_at = now() - interval '1 hour'
      WHERE id = ${expiredId}
    `);

    const active = await apiKeysRepository.findById(activeId);
    expect(active).toMatchObject({ id: activeId, name: "ordinary-active-key" });
    await expect(apiKeysRepository.findByHash(active!.key_hash)).resolves.toMatchObject({
      id: activeId,
    });
    await expect(apiKeysRepository.findActiveByHash(active!.key_hash)).resolves.toMatchObject({
      id: activeId,
    });
    await expect(
      apiKeysRepository.findActiveByHashConsistent(active!.key_hash),
    ).resolves.toMatchObject({ id: activeId });

    const expired = await apiKeysRepository.findByIdConsistent(expiredId);
    expect(expired).toMatchObject({ id: expiredId });
    await expect(apiKeysRepository.findActiveByHash(expired!.key_hash)).resolves.toBeUndefined();
    await expect(
      apiKeysRepository.findActiveByHashConsistent(expired!.key_hash),
    ).resolves.toBeUndefined();
    await expect(
      apiKeysRepository.findByUserAndName(USER_ID, "ordinary-active-key"),
    ).resolves.toEqual([expect.objectContaining({ id: activeId })]);
    await expect(apiKeysRepository.findByName("ordinary-active-key")).resolves.toEqual([
      expect.objectContaining({ id: activeId }),
    ]);
    await expect(apiKeysRepository.listByUser(USER_ID)).resolves.toHaveLength(2);

    await expect(
      apiKeysRepository.update(activeId, { description: "rotated" }),
    ).resolves.toMatchObject({
      id: activeId,
      description: "rotated",
    });
    await apiKeysRepository.incrementUsage(activeId);
    await expect(apiKeysRepository.findByIdConsistent(activeId)).resolves.toMatchObject({
      usage_count: 1,
    });

    await apiKeysRepository.deactivateUserKeysByName(USER_ID, "ordinary-active-key");
    await expect(apiKeysRepository.findByIdConsistent(activeId)).resolves.toMatchObject({
      is_active: false,
    });
    const deleted = await apiKeysRepository.deleteByName("ordinary-active-key");
    expect(deleted).toEqual([expect.objectContaining({ id: activeId })]);
    await expect(apiKeysRepository.findByIdConsistent(activeId)).resolves.toBeUndefined();
  });

  test("mobile owner recovery lists, resolves, and tombstones only scoped credentials", async () => {
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const sourceAppId = "44444444-4444-4444-8444-444444444444";
    const keyHash = "a".repeat(64);
    await insertMobileKey({ id: credentialId, keyHash, sourceAppId });

    await expect(apiKeysRepository.findByHashConsistent(keyHash)).resolves.toMatchObject({
      id: credentialId,
    });
    await expect(
      apiKeysRepository.findExactActiveMobileConsistent(credentialId, keyHash),
    ).resolves.toMatchObject({ id: credentialId });
    await expect(apiKeysRepository.listMobileByOwnerConsistent(USER_ID, ORG_ID)).resolves.toEqual([
      expect.objectContaining({ id: credentialId }),
    ]);
    await expect(
      apiKeysRepository.findMobileByOwnerConsistent(credentialId, USER_ID, ORG_ID),
    ).resolves.toMatchObject({ id: credentialId });
    await expect(
      apiKeysRepository.findMobileByOwnerConsistent(
        credentialId,
        "55555555-5555-4555-8555-555555555555",
        ORG_ID,
      ),
    ).resolves.toBeUndefined();

    const revokedAt = new Date("2026-07-18T12:00:00.000Z");
    await expect(
      apiKeysRepository.tombstoneMobileByOwner(credentialId, USER_ID, ORG_ID, revokedAt),
    ).resolves.toMatchObject({
      id: credentialId,
      is_active: false,
      key_ciphertext: null,
      key_nonce: null,
      key_auth_tag: null,
      key_kms_key_id: null,
      key_kms_key_version: null,
    });
    await expect(
      apiKeysRepository.findExactActiveMobileConsistent(credentialId, keyHash),
    ).resolves.toBeUndefined();
  });

  test("exact mobile tombstone keeps an existing receipt stable", async () => {
    const credentialId = "66666666-6666-4666-8666-666666666666";
    const sourceAppId = "77777777-7777-4777-8777-777777777777";
    const keyHash = "b".repeat(64);
    await insertMobileKey({ id: credentialId, keyHash, sourceAppId });

    const revokedAt = new Date("2026-07-18T12:00:00.000Z");
    await expect(
      apiKeysRepository.tombstoneExactMobileCredential(credentialId, keyHash, revokedAt),
    ).resolves.toMatchObject({ id: credentialId, deleted_at: revokedAt });
    await expect(
      apiKeysRepository.tombstoneExactMobileCredential(
        credentialId,
        keyHash,
        new Date("2026-07-19T12:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    await expect(apiKeysRepository.findByIdConsistent(credentialId)).resolves.toMatchObject({
      id: credentialId,
      deleted_at: revokedAt,
    });
  });
});

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM api_keys`);
  await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
  // The LIVE sandbox row exists for the "never touch a bound key" case.
  await dbWrite.execute(sql`INSERT INTO agent_sandboxes (id) VALUES (${SANDBOX_LIVE})`);
});

afterAll(async () => {
  await dbWrite.execute(sql`DROP TABLE IF EXISTS api_keys`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS agent_sandboxes`);
  await closeDatabaseConnectionsForTests();
});

describe("strandedAgentKeyRepository.deleteOlderThan (#16071)", () => {
  test("returns a stranded key: no sandbox row + past the grace window", async () => {
    const strandedId = await insertKey({
      name: `agent-sandbox:${SANDBOX_STRANDED}`,
      createdAtSql: "now() - interval '1 day'",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h grace
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found.map((k) => k.id)).toEqual([strandedId]);
  });

  test("NEVER touches a key minted moments ago for an in-flight mint (grace window)", async () => {
    // Same stranded shape (no sandbox row) but created just now — still inside
    // the tier-upgrade lock window, so the grace cutoff must exclude it.
    await insertKey({
      name: `agent-sandbox:${SANDBOX_INFLIGHT}`,
      createdAtSql: "now()",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found).toHaveLength(0);
  });

  test("NEVER touches a key correctly bound to a live sandbox", async () => {
    // Old enough to clear the grace window, but its sandbox row EXISTS.
    await insertKey({
      name: `agent-sandbox:${SANDBOX_LIVE}`,
      createdAtSql: "now() - interval '1 day'",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found).toHaveLength(0);
    const remaining = (await dbWrite.execute(sql`
      SELECT id FROM api_keys WHERE name = ${`agent-sandbox:${SANDBOX_LIVE}`}
    `)) as { rows: Array<{ id: string }> };
    expect(remaining.rows).toHaveLength(1);
  });

  test("ignores non-sandbox keys and already-revoked stranded keys", async () => {
    // A user key that merely resembles nothing of the pattern.
    await insertKey({ name: "my personal key", createdAtSql: "now() - interval '1 day'" });
    // An INACTIVE stranded key — already revoked, must not be re-selected.
    await insertKey({
      name: `agent-sandbox:${SANDBOX_STRANDED}`,
      isActive: false,
      createdAtSql: "now() - interval '1 day'",
    });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found).toHaveLength(0);
  });

  test("mixed fixture returns exactly the one stranded, past-grace, active key", async () => {
    const strandedId = await insertKey({
      name: `agent-sandbox:${SANDBOX_STRANDED}`,
      createdAtSql: "now() - interval '1 day'",
    });
    await insertKey({
      name: `agent-sandbox:${SANDBOX_LIVE}`,
      createdAtSql: "now() - interval '1 day'",
    });
    await insertKey({
      name: `agent-sandbox:${SANDBOX_INFLIGHT}`,
      createdAtSql: "now()",
    });
    await insertKey({ name: "eliza cloud key", createdAtSql: "now() - interval '1 day'" });

    const olderThan = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const found = await strandedAgentKeyRepository.deleteOlderThan(olderThan);

    expect(found.map((k) => k.id)).toEqual([strandedId]);
  });
});
