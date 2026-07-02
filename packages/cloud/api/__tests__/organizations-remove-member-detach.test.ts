/**
 * DELETE /api/organizations/members/[userId] — detach, don't destroy (#11332).
 *
 * The bug: removing an org member called `usersService.delete(userId)` — a hard
 * `DELETE FROM users` that destroyed the member's entire account (and, via FK
 * cascade, their API keys). An owner/admin clicking "remove" in members
 * settings nuked a teammate's identity instead of just taking away org access.
 *
 * The fix: the route detaches — the removed user is moved to a fresh personal
 * organization where they are owner (the same shape signup auto-creates), their
 * account survives, and their API keys scoped to the old org are deactivated
 * (org-scoped credentials must not keep spending the old org's credits). The
 * new org starts at $0 — an invite→remove cycle must not mint welcome credits.
 *
 * These tests drive the REAL route handler + REAL usersService/repositories
 * against in-process PGlite (real SQL). Only auth, rate-limit, and the route
 * logger are stubbed. RBAC (member can't remove, admin can't remove admin,
 * owner can't be removed, no self-removal) is asserted to survive the change.
 * Fails loudly via the `pgliteReady` guard if PGlite ever fails to init.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.MOCK_REDIS = "1";
process.env.NODE_ENV ||= "test";

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_ID = "00000000-0000-4000-8000-0000000000b1";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000b2";
const ADMIN2_ID = "00000000-0000-4000-8000-0000000000b3";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000c1";
const WALLET_MEMBER_ID = "00000000-0000-4000-8000-0000000000c2";
const PGLITE_TIMEOUT = 60000;

// The route reads currentUser from requireUserOrApiKeyWithOrg; make it settable
// per test. Full (non-spread) module mock is safe here: cloud-api test files run
// one-per-process (test/run-unit-isolated.mjs) and this file's import graph only
// uses this one export from the auth module.
let currentUser: { id: string; role: string; organization_id: string };
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => currentUser,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let dbWrite: typeof import("../../shared/src/db/client").dbWrite;
let closeDb:
  | typeof import("../../shared/src/db/client").closeDatabaseConnectionsForTests
  | undefined;
let app: Hono;
let pgliteReady = true;

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
      "../../shared/src/db/client"
    ));
    const ddl = [
      // Full column sets — the repositories select * on these tables.
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        credit_balance numeric(12,6) NOT NULL DEFAULT '0',
        settings jsonb DEFAULT '{}',
        stripe_customer_id text,
        billing_email text,
        stripe_payment_method_id text,
        stripe_default_payment_method text,
        auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(10,2),
        auto_top_up_amount numeric(10,2),
        pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true,
        steward_tenant_id text UNIQUE,
        steward_tenant_api_key text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE,
        email_verified boolean DEFAULT false,
        wallet_address text UNIQUE,
        wallet_chain_type text,
        wallet_verified boolean NOT NULL DEFAULT false,
        name text,
        avatar text,
        organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        steward_user_id text NOT NULL UNIQUE,
        telegram_id text UNIQUE,
        telegram_username text,
        telegram_first_name text,
        telegram_photo_url text,
        discord_id text UNIQUE,
        discord_username text,
        discord_global_name text,
        discord_avatar_url text,
        whatsapp_id text UNIQUE,
        whatsapp_name text,
        phone_number text UNIQUE,
        phone_verified boolean DEFAULT false,
        is_anonymous boolean NOT NULL DEFAULT false,
        anonymous_session_id text,
        expires_at timestamp,
        nickname text,
        work_function text,
        preferences text,
        email_notifications boolean DEFAULT true,
        response_notifications boolean DEFAULT true,
        is_active boolean NOT NULL DEFAULT true,
        email_ciphertext text, email_nonce text, email_auth_tag text,
        email_kms_key_id text, email_kms_key_version integer, email_blind_index text,
        phone_ciphertext text, phone_nonce text, phone_auth_tag text,
        phone_kms_key_id text, phone_kms_key_version integer, phone_blind_index text,
        wallet_address_ciphertext text, wallet_address_nonce text, wallet_address_auth_tag text,
        wallet_address_kms_key_id text, wallet_address_kms_key_version integer,
        wallet_address_blind_index text,
        telegram_id_ciphertext text, telegram_id_nonce text, telegram_id_auth_tag text,
        telegram_id_kms_key_id text, telegram_id_kms_key_version integer,
        discord_id_ciphertext text, discord_id_nonce text, discord_id_auth_tag text,
        discord_id_kms_key_id text, discord_id_kms_key_version integer,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        deleted_at timestamp
      )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        description text,
        key_hash text NOT NULL UNIQUE,
        key_prefix text NOT NULL,
        key_ciphertext text, key_nonce text, key_auth_tag text,
        key_kms_key_id text, key_kms_key_version integer,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rate_limit integer NOT NULL DEFAULT 1000,
        is_active boolean NOT NULL DEFAULT true,
        usage_count integer NOT NULL DEFAULT 0,
        expires_at timestamp,
        last_used_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        deleted_at timestamp
      )`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);

    // Mount the real route app exactly as src/_router.generated.ts does.
    const route = await import("../organizations/members/[userId]/route");
    app = new Hono();
    app.route(
      "/api/organizations/members/:userId",
      route.default as unknown as Hono,
    );
  } catch (error) {
    pgliteReady = false;
    console.warn(
      "[organizations-remove-member-detach] PGlite unavailable, skipping:",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  if (!pgliteReady) return;
  await dbWrite.execute(`DELETE FROM api_keys;`);
  await dbWrite.execute(`DELETE FROM users;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug) VALUES ('${ORG_A}', 'Team Org', 'team-org');`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, email, name, organization_id, role, steward_user_id) VALUES
       ('${OWNER_ID}', 'owner@example.com', 'owner', '${ORG_A}', 'owner', 'steward-owner'),
       ('${ADMIN_ID}', 'admin@example.com', 'admin', '${ORG_A}', 'admin', 'steward-admin'),
       ('${ADMIN2_ID}', 'admin2@example.com', 'admin2', '${ORG_A}', 'admin', 'steward-admin2'),
       ('${MEMBER_ID}', 'member1@example.com', 'member one', '${ORG_A}', 'member', 'steward-member');`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, wallet_address, organization_id, role, steward_user_id) VALUES
       ('${WALLET_MEMBER_ID}', '0xAbCdEf1234567890', '${ORG_A}', 'member', 'steward-wallet');`,
  );
  await dbWrite.execute(
    `INSERT INTO api_keys (name, key_hash, key_prefix, organization_id, user_id) VALUES
       ('member key', 'hash-member-a', 'eliza_m1', '${ORG_A}', '${MEMBER_ID}'),
       ('owner key', 'hash-owner-a', 'eliza_o1', '${ORG_A}', '${OWNER_ID}');`,
  );
  currentUser = { id: OWNER_ID, role: "owner", organization_id: ORG_A };
});

async function removeMember(userId: string): Promise<Response> {
  return await app.fetch(
    new Request(`http://test.local/api/organizations/members/${userId}`, {
      method: "DELETE",
    }),
  );
}

async function userRow(
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const r = await dbWrite.execute(`SELECT * FROM users WHERE id='${id}';`);
  return r.rows[0] as Record<string, unknown> | undefined;
}

async function orgMemberIds(orgId: string): Promise<string[]> {
  const r = await dbWrite.execute(
    `SELECT id FROM users WHERE organization_id='${orgId}' ORDER BY id;`,
  );
  return (r.rows as Array<{ id: string }>).map((row) => row.id);
}

describe("remove member — detaches instead of deleting the account", () => {
  test(
    "removed member's account SURVIVES as owner of a fresh $0 personal org; old-org keys revoked",
    async () => {
      if (!pgliteReady) return;

      const res = await removeMember(MEMBER_ID);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // The account still exists (pre-fix: hard-deleted → this is the bug).
      const member = await userRow(MEMBER_ID);
      expect(member).toBeDefined();
      if (!member) throw new Error("unreachable");

      // Detached into a fresh personal org, as owner.
      expect(member.organization_id).not.toBeNull();
      expect(member.organization_id).not.toBe(ORG_A);
      expect(member.role).toBe("owner");

      // The personal org exists, is slugged from the member's email local-part
      // (mirroring signup), holds exactly this user, and starts at $0.
      const orgRes = await dbWrite.execute(
        `SELECT * FROM organizations WHERE id='${member.organization_id}';`,
      );
      const personalOrg = orgRes.rows[0] as
        | { slug: string; credit_balance: string; name: string }
        | undefined;
      expect(personalOrg).toBeDefined();
      if (!personalOrg) throw new Error("unreachable");
      expect(personalOrg.slug.startsWith("member1-")).toBe(true);
      expect(Number(personalOrg.credit_balance)).toBeCloseTo(0, 6);
      expect(await orgMemberIds(member.organization_id as string)).toEqual([
        MEMBER_ID,
      ]);

      // The original org is intact and no longer lists the removed member.
      expect(await orgMemberIds(ORG_A)).toEqual(
        [OWNER_ID, ADMIN_ID, ADMIN2_ID, WALLET_MEMBER_ID].sort(),
      );

      // The member's key in the old org is revoked (it authenticates AS the old
      // org); the owner's key is untouched.
      const keys = await dbWrite.execute(
        `SELECT key_hash, is_active FROM api_keys ORDER BY key_hash;`,
      );
      expect(keys.rows).toEqual([
        { key_hash: "hash-member-a", is_active: false },
        { key_hash: "hash-owner-a", is_active: true },
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "wallet-only member (no email) detaches with a wallet-derived personal-org slug",
    async () => {
      if (!pgliteReady) return;

      const res = await removeMember(WALLET_MEMBER_ID);
      expect(res.status).toBe(200);

      const member = await userRow(WALLET_MEMBER_ID);
      expect(member).toBeDefined();
      if (!member) throw new Error("unreachable");
      expect(member.role).toBe("owner");
      expect(member.organization_id).not.toBe(ORG_A);

      const orgRes = await dbWrite.execute(
        `SELECT slug FROM organizations WHERE id='${member.organization_id}';`,
      );
      const slug = (orgRes.rows[0] as { slug: string } | undefined)?.slug ?? "";
      expect(slug.startsWith("wallet-0xabcdef")).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "admin can also remove a member — same detach semantics",
    async () => {
      if (!pgliteReady) return;
      currentUser = { id: ADMIN_ID, role: "admin", organization_id: ORG_A };

      const res = await removeMember(MEMBER_ID);
      expect(res.status).toBe(200);
      const member = await userRow(MEMBER_ID);
      expect(member).toBeDefined();
      expect(member?.organization_id).not.toBe(ORG_A);
      expect(member?.role).toBe("owner");
    },
    PGLITE_TIMEOUT,
  );
});

describe("remove member — RBAC survives the detach change", () => {
  test(
    "a plain member cannot remove anyone (403, target untouched)",
    async () => {
      if (!pgliteReady) return;
      currentUser = { id: MEMBER_ID, role: "member", organization_id: ORG_A };

      const res = await removeMember(WALLET_MEMBER_ID);
      expect(res.status).toBe(403);
      const target = await userRow(WALLET_MEMBER_ID);
      expect(target?.organization_id).toBe(ORG_A);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an admin cannot remove another admin (403)",
    async () => {
      if (!pgliteReady) return;
      currentUser = { id: ADMIN_ID, role: "admin", organization_id: ORG_A };

      const res = await removeMember(ADMIN2_ID);
      expect(res.status).toBe(403);
      expect((await userRow(ADMIN2_ID))?.organization_id).toBe(ORG_A);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the organization owner cannot be removed (400)",
    async () => {
      if (!pgliteReady) return;
      currentUser = { id: ADMIN_ID, role: "admin", organization_id: ORG_A };

      const res = await removeMember(OWNER_ID);
      expect(res.status).toBe(400);
      expect((await userRow(OWNER_ID))?.organization_id).toBe(ORG_A);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "self-removal is rejected (400)",
    async () => {
      if (!pgliteReady) return;

      const res = await removeMember(OWNER_ID);
      expect(res.status).toBe(400);
      expect((await userRow(OWNER_ID))?.organization_id).toBe(ORG_A);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "cross-org removal is rejected (403)",
    async () => {
      if (!pgliteReady) return;
      currentUser = {
        id: OWNER_ID,
        role: "owner",
        organization_id: "00000000-0000-4000-8000-0000000000ff",
      };

      const res = await removeMember(MEMBER_ID);
      expect(res.status).toBe(403);
      expect((await userRow(MEMBER_ID))?.organization_id).toBe(ORG_A);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If it ever fails to init, the tests above early-return; this turns that
// silent no-op into a hard failure so the detach proof can't go vacuous-green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
