/**
 * Exercises charge-time affiliate attribution against the primary PGlite
 * database, including deterministic user selection and active-code filtering.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 60_000;
const ORG_A = "52000000-0000-4000-8000-000000000001";
const ORG_B = "52000000-0000-4000-8000-000000000002";
const USER_FIRST = "52000000-0000-4000-8000-000000000011";
const USER_SECOND = "52000000-0000-4000-8000-000000000012";
const USER_BILLING = "52000000-0000-4000-8000-000000000013";
const USER_OWNER = "52000000-0000-4000-8000-000000000014";
const CODE_ACTIVE = "52000000-0000-4000-8000-000000000021";
const CODE_INACTIVE = "52000000-0000-4000-8000-000000000022";

let dbWrite: typeof import("../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: import("./affiliates").AffiliatesRepository;

async function insertOrganization(id: string, billingEmail: string | null = null): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO organizations (id, billing_email)
    VALUES (${id}, ${billingEmail})
  `);
}

async function insertUser(input: {
  id: string;
  organizationId?: string | null;
  email: string;
  createdAt: Date;
}): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO users (id, organization_id, email, created_at)
    VALUES (${input.id}, ${input.organizationId ?? null}, ${input.email}, ${input.createdAt})
  `);
}

async function linkAffiliate(input: {
  referredUserId: string;
  codeId: string;
  code: string;
  active: boolean;
}): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO affiliate_codes (id, user_id, code, is_active)
    VALUES (${input.codeId}, ${USER_OWNER}, ${input.code}, ${input.active})
  `);
  await dbWrite.execute(sql`
    INSERT INTO user_affiliates (user_id, affiliate_code_id)
    VALUES (${input.referredUserId}, ${input.codeId})
  `);
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
    "../client"
  ));
  ({ affiliatesRepository: repository } = await import("./affiliates"));

  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      billing_email text
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email text,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE affiliate_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code text NOT NULL UNIQUE,
      parent_referral_id uuid REFERENCES affiliate_codes(id) ON DELETE SET NULL,
      markup_percent numeric(6,2) NOT NULL DEFAULT 20.00,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE user_affiliates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      affiliate_code_id uuid NOT NULL REFERENCES affiliate_codes(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX user_affiliates_user_idx ON user_affiliates (user_id);
  `);
}, TIMEOUT);

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    DELETE FROM user_affiliates;
    DELETE FROM affiliate_codes;
    DELETE FROM users;
    DELETE FROM organizations;
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("AffiliatesRepository.getBillingAttributionForOrganization", () => {
  test("returns no attribution when the organization or its user is absent", async () => {
    expect(await repository.getBillingAttributionForOrganization(ORG_A)).toEqual({
      userId: null,
      affiliateCode: null,
    });

    await insertOrganization(ORG_A);
    expect(await repository.getBillingAttributionForOrganization(ORG_A)).toEqual({
      userId: null,
      affiliateCode: null,
    });
  });

  test("attributes billing to the matching billing-email user", async () => {
    await insertOrganization(ORG_A, "billing@example.com");
    await insertUser({
      id: USER_FIRST,
      organizationId: ORG_A,
      email: "first@example.com",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await insertUser({
      id: USER_BILLING,
      organizationId: ORG_A,
      email: "billing@example.com",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await insertUser({
      id: USER_OWNER,
      email: "affiliate-owner@example.com",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    await linkAffiliate({
      referredUserId: USER_BILLING,
      codeId: CODE_ACTIVE,
      code: "PRIMARY20",
      active: true,
    });

    const result = await repository.getBillingAttributionForOrganization(ORG_A);

    expect(result.userId).toBe(USER_BILLING);
    expect(result.affiliateCode).toMatchObject({
      id: CODE_ACTIVE,
      code: "PRIMARY20",
      is_active: true,
    });
  });

  test("falls back deterministically by creation time and user id", async () => {
    await insertOrganization(ORG_A, "missing@example.com");
    const sameCreatedAt = new Date("2026-02-01T00:00:00.000Z");
    await insertUser({
      id: USER_SECOND,
      organizationId: ORG_A,
      email: "second@example.com",
      createdAt: sameCreatedAt,
    });
    await insertUser({
      id: USER_FIRST,
      organizationId: ORG_A,
      email: "first@example.com",
      createdAt: sameCreatedAt,
    });

    expect(await repository.getBillingAttributionForOrganization(ORG_A)).toEqual({
      userId: USER_FIRST,
      affiliateCode: null,
    });
  });

  test("returns the selected user without an inactive affiliate code", async () => {
    await insertOrganization(ORG_B);
    await insertUser({
      id: USER_SECOND,
      organizationId: ORG_B,
      email: "referred@example.com",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    await insertUser({
      id: USER_OWNER,
      email: "affiliate-owner@example.com",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    await linkAffiliate({
      referredUserId: USER_SECOND,
      codeId: CODE_INACTIVE,
      code: "DISABLED20",
      active: false,
    });

    expect(await repository.getBillingAttributionForOrganization(ORG_B)).toEqual({
      userId: USER_SECOND,
      affiliateCode: null,
    });
  });
});
