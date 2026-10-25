/**
 * Proves the inference API-key boundary resolves key, user, and organization
 * with one primary statement on PGlite (#30724) while keeping every credential
 * and account rejection, its error class, message, and ordering.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { apiKeys } from "../../db/schemas/api-keys";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { AuthenticationError, ForbiddenError } from "../api/errors";
import { requireInferenceApiKeyWithOrg } from "./inference-api-key-auth";

const ORG = "81000000-0000-4000-8000-000000000001";
const INACTIVE_ORG = "81000000-0000-4000-8000-000000000002";
const USER = "82000000-0000-4000-8000-000000000001";
const INACTIVE_USER = "82000000-0000-4000-8000-000000000002";
const ORGLESS_USER = "82000000-0000-4000-8000-000000000003";
const INACTIVE_ORG_USER = "82000000-0000-4000-8000-000000000004";
const MISSING_USER = "82000000-0000-4000-8000-000000000009";

/** Schema-derived table without constraints; rows below supply every value read. */
async function createTable(table: PgTable): Promise<void> {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
    return `"${column.name}" ${type}`;
  });
  await getPgliteClientForTests().exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

let keySequence = 0;
async function seedKey(values: {
  userId: string;
  organizationId: string;
  isActive?: boolean;
  deleted?: boolean;
  expired?: boolean;
}): Promise<string> {
  keySequence += 1;
  const rawKey = `eliza_test_inference_key_${keySequence}`;
  await getPgliteClientForTests().query(
    `INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, is_active,
       deleted_at, expires_at, usage_count, rate_limit, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'eliza_te', $3, $4, $5, $6, $7, 0, 1000, now(), now())`,
    [
      `key-${keySequence}`,
      createHash("sha256").update(rawKey).digest("hex"),
      values.organizationId,
      values.userId,
      values.isActive ?? true,
      values.deleted ? new Date() : null,
      values.expired ? new Date(Date.now() - 60_000) : null,
    ],
  );
  return rawKey;
}

beforeAll(async () => {
  await createTable(organizations);
  await createTable(users);
  await createTable(apiKeys);
  const db = getPgliteClientForTests();
  await db.query(
    `INSERT INTO organizations(id, name, slug, credit_balance, is_active)
     VALUES ($1, 'Active org', 'active-org', '5.000000', true),
            ($2, 'Inactive org', 'inactive-org', '5.000000', false)`,
    [ORG, INACTIVE_ORG],
  );
  await db.query(
    `INSERT INTO users(id, organization_id, is_active)
     VALUES ($1, $5, true), ($2, $5, false), ($3, NULL, true), ($4, $6, true)`,
    [USER, INACTIVE_USER, ORGLESS_USER, INACTIVE_ORG_USER, ORG, INACTIVE_ORG],
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function rejection(rawKey: string) {
  const reasons: string[] = [];
  const identityLookups: number[] = [];
  const error = await requireInferenceApiKeyWithOrg(rawKey, {
    rejected: (reason) => reasons.push(reason),
    timing: { identityLookup: (durationMs) => identityLookups.push(durationMs) },
  }).then(
    () => null,
    (caught: unknown) => caught,
  );
  return { error, reasons, identityLookups };
}

describe("inference API-key identity", () => {
  test("one primary statement returns the key, user, and organization", async () => {
    const rawKey = await seedKey({ userId: USER, organizationId: ORG });
    const identityLookups: number[] = [];
    const result = await requireInferenceApiKeyWithOrg(rawKey, {
      timing: { identityLookup: (durationMs) => identityLookups.push(durationMs) },
    });
    expect(result.authMethod).toBe("api_key");
    expect(result.apiKey.user_id).toBe(USER);
    expect(result.user.id).toBe(USER);
    expect(result.user.organization_id).toBe(ORG);
    expect(result.user.organization).toMatchObject({ id: ORG, is_active: true });
    expect(result.user.organization.credit_balance).toBe("5.000000");
    // The combined read is timed once, not as separate key and user hops.
    expect(identityLookups).toHaveLength(1);
  });

  test("credential rejections keep their classes, messages, and reasons", async () => {
    const unknown = await rejection("eliza_test_inference_key_unknown");
    expect(unknown.error).toBeInstanceOf(AuthenticationError);
    expect((unknown.error as Error).message).toBe("Invalid or expired API key");
    expect(unknown.reasons).toEqual(["credential_invalid"]);
    expect(unknown.identityLookups).toHaveLength(1);

    const deleted = await rejection(
      await seedKey({ userId: USER, organizationId: ORG, deleted: true }),
    );
    expect(deleted.error).toBeInstanceOf(AuthenticationError);
    expect((deleted.error as Error).message).toBe("Invalid or expired API key");
    expect(deleted.reasons).toEqual(["credential_invalid"]);

    const expired = await rejection(
      await seedKey({ userId: USER, organizationId: ORG, expired: true }),
    );
    expect(expired.error).toBeInstanceOf(AuthenticationError);
    expect((expired.error as Error).message).toBe("API key has expired");
    expect(expired.reasons).toEqual(["credential_invalid"]);

    const inactive = await rejection(
      await seedKey({ userId: USER, organizationId: ORG, isActive: false }),
    );
    expect(inactive.error).toBeInstanceOf(ForbiddenError);
    expect((inactive.error as Error).message).toBe("API key is inactive");
    expect(inactive.reasons).toEqual(["credential_inactive"]);
  });

  test("account rejections keep their order after credential checks", async () => {
    const missing = await rejection(await seedKey({ userId: MISSING_USER, organizationId: ORG }));
    expect(missing.error).toBeInstanceOf(AuthenticationError);
    expect((missing.error as Error).message).toBe("User associated with API key not found");
    expect(missing.reasons).toEqual(["membership_missing"]);

    const inactiveUser = await rejection(
      await seedKey({ userId: INACTIVE_USER, organizationId: ORG }),
    );
    expect(inactiveUser.error).toBeInstanceOf(ForbiddenError);
    expect((inactiveUser.error as Error).message).toBe("User account is inactive");
    expect(inactiveUser.reasons).toEqual(["account_inactive"]);

    const orgless = await rejection(await seedKey({ userId: ORGLESS_USER, organizationId: ORG }));
    expect(orgless.error).toBeInstanceOf(ForbiddenError);
    expect(orgless.reasons).toEqual(["membership_missing"]);

    const inactiveOrg = await rejection(
      await seedKey({ userId: INACTIVE_ORG_USER, organizationId: INACTIVE_ORG }),
    );
    expect(inactiveOrg.error).toBeInstanceOf(ForbiddenError);
    expect((inactiveOrg.error as Error).message).toBe("Organization is inactive");
    expect(inactiveOrg.reasons).toEqual(["organization_inactive"]);

    // An inactive key on an inactive account still reports the key first.
    const both = await rejection(
      await seedKey({ userId: INACTIVE_USER, organizationId: ORG, isActive: false }),
    );
    expect(both.reasons).toEqual(["credential_inactive"]);
  });
});
