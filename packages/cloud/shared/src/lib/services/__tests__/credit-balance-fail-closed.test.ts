/**
 * Exercises credit balance reads, mutations and DTO errors with real PGlite.
 * Production Drizzle schemas and the 0177 revision trigger own default balances,
 * ledger writes and no-effect rejection of stored NaN. Only balance nullability
 * is relaxed to model legacy corruption; DTO cases fake the service boundary.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports. resolveDatabaseUrl
// prefers TEST_DATABASE_URL, so BOTH are pinned — otherwise the suite is steered
// to a Postgres that isn't up under the unit lane and self-skips to a vacuous
// green (a money-path proof shipping unproven).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { organizationsRepository } from "../../../db/repositories/organizations";
import { creditTransactions } from "../../../db/schemas/credit-transactions";
import {
  type Organization,
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";
import { ApiError } from "../../api/cloud-worker-errors";
import { getCreditBalanceResponse } from "../credit-balance-response";
import { creditsService } from "../credits";
import { organizationsService } from "../organizations";

const PGLITE_TIMEOUT = 60_000;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrg(creditBalance: string): Promise<string> {
  const [row] = await dbWrite
    .insert(organizations)
    .values({ name: "Balance Org", slug: uniq("balance"), credit_balance: creditBalance })
    .returning({ id: organizations.id });
  return row.id;
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    { organizations, organizationBalanceRevisionSequence, users, creditTransactions } as never,
    dbWrite as never,
  );
  await apply();
  // pushSchema derives DDL from the drizzle schema, which cannot express the
  // 0177 balance-revision trigger. Apply the real migration file (its
  // statements are IF NOT EXISTS / OR REPLACE safe on top of pushSchema) so
  // the snapshot read is proven against the same trigger production deploys.
  const migration0177 = readFileSync(
    join(import.meta.dir, "../../../db/migrations/0177_organization_balance_revision.sql"),
    "utf8",
  );
  for (const statement of migration0177.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await dbWrite.execute(trimmed);
  }
  // Production DDL is NOT NULL; the proof DB relaxes ONLY nullability so a
  // corrupt/legacy row can be driven through the service's real read SQL.
  // The parse gate must fail closed on it rather than serving a fake $0.
  await dbWrite.execute("ALTER TABLE organizations ALTER COLUMN credit_balance DROP NOT NULL");
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
});

describe("CreditsService.getOrganizationBalanceUsd fail-closed (real PGlite + 0177)", () => {
  test("parses a well-formed numeric balance and reports the trigger-advanced revision", async () => {
    const orgId = await seedOrg("12.500000");
    expect(await creditsService.getOrganizationBalanceUsd(orgId)).toBe(12.5);

    const before = await creditsService.getOrganizationBalanceSnapshot(orgId);
    expect(before.balanceUsd).toBe(12.5);
    expect(before.revision).toBe("0");

    // A real credit_balance UPDATE must advance the 0177 trigger revision the
    // snapshot serves to the admission gate.
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = credit_balance - 2.5 WHERE id = ${orgId}`,
    );
    const after = await creditsService.getOrganizationBalanceSnapshot(orgId);
    expect(after.balanceUsd).toBe(10);
    expect(BigInt(after.revision) > BigInt(before.revision)).toBe(true);
  });

  test("missing org returns 0 (documented gate fail-safe -> slow path)", async () => {
    expect(await creditsService.getOrganizationBalanceUsd(crypto.randomUUID())).toBe(0);
  });

  test("stored 'NaN'::numeric THROWS instead of poisoning the gate hint", async () => {
    const orgId = await seedOrg("5.000000");
    // 'NaN' is a legal constrained-NUMERIC value and passes the >= 0 CHECK
    // (NaN sorts above all numbers) — the genuine production corruption vector.
    await dbWrite.execute(
      sql`UPDATE organizations SET credit_balance = 'NaN'::numeric WHERE id = ${orgId}`,
    );
    await expect(creditsService.getOrganizationBalanceUsd(orgId)).rejects.toThrow(
      "[CreditsService] Invalid numeric credit_balance",
    );
  });

  test("NULL balance on a corrupt/legacy row THROWS instead of coercing to $0", async () => {
    const orgId = await seedOrg("5.000000");
    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = NULL WHERE id = ${orgId}`);
    await expect(creditsService.getOrganizationBalanceUsd(orgId)).rejects.toThrow(
      "[CreditsService] Invalid numeric credit_balance",
    );
  });
});

test("organization mutations preserve the ledger and reject corrupt or negative balances", async () => {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Mutation Org", slug: uniq("mutation") })
    .returning();
  expect(Number(org.credit_balance)).toBe(0);
  expect(await organizationsRepository.updateCreditBalance(org.id, 5)).toEqual({
    success: true,
    newBalance: 5,
  });
  const debit = await organizationsRepository.deductCreditsWithTransaction(org.id, 1, "proof");
  expect(debit.newBalance).toBe(4);
  expect(Number(debit.transaction.amount)).toBe(-1);
  expect(debit.transaction.organization_id).toBe(org.id);

  const snapshot = async () =>
    (
      await dbWrite.execute(sql`
    SELECT credit_balance::text AS balance, balance_revision::text AS revision,
      (SELECT count(*)::int FROM credit_transactions WHERE organization_id = ${org.id}) AS entries
    FROM organizations WHERE id = ${org.id}
  `)
    ).rows;
  const settled = await snapshot();
  expect(Number(settled[0]?.balance)).toBe(4);
  expect(settled[0]?.entries).toBe(1);
  await dbWrite.execute(
    sql`UPDATE organizations SET credit_balance = 'NaN'::numeric WHERE id = ${org.id}`,
  );
  const before = await snapshot();
  expect(before[0]).toMatchObject({ balance: "NaN", entries: 1 });
  for (const mutate of [
    () => organizationsRepository.updateCreditBalance(org.id, 1),
    () => organizationsRepository.deductCreditsWithTransaction(org.id, 1, "denied"),
  ]) {
    await expect(mutate()).rejects.toThrow(/Unable to read organization credit_balance/);
    expect(await snapshot()).toEqual(before);
  }
  await expect(
    Promise.resolve(
      dbWrite.execute(sql`
      UPDATE organizations SET credit_balance = -1 WHERE id = ${org.id}
    `),
    ),
  ).rejects.toMatchObject({ cause: { code: "23514", constraint: "credit_balance_non_negative" } });
  expect(await snapshot()).toEqual(before);
});

function orgWithBalance(credit_balance: unknown): Organization {
  // Only `credit_balance` is exercised by the code under test; the rest of the
  // row is irrelevant, so cast a minimal object to the row type.
  return { id: crypto.randomUUID(), credit_balance } as unknown as Organization;
}

describe("getCreditBalanceResponse fail-closed", () => {
  test("returns the parsed balance for a well-formed row", async () => {
    const org = orgWithBalance("42.000000");
    const s = spyOn(organizationsService, "getById").mockResolvedValue(org);
    spies.push(s);
    expect(await getCreditBalanceResponse(org.id)).toEqual({ balance: 42 });
  });

  test("missing org throws a 404 (unchanged behavior)", async () => {
    const s = spyOn(organizationsService, "getById").mockResolvedValue(undefined);
    spies.push(s);
    await expect(getCreditBalanceResponse(crypto.randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });

  test("null balance throws a 500 internal_error, not a fake $0 (Number(null)===0)", async () => {
    const org = orgWithBalance(null);
    const s = spyOn(organizationsService, "getById").mockResolvedValue(org);
    spies.push(s);
    let thrown: unknown;
    try {
      await getCreditBalanceResponse(org.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(500);
    expect((thrown as ApiError).code).toBe("internal_error");
  });

  test("non-numeric balance throws a 500 internal_error, not balance:null", async () => {
    const org = orgWithBalance("not-a-number");
    const s = spyOn(organizationsService, "getById").mockResolvedValue(org);
    spies.push(s);
    let thrown: unknown;
    try {
      await getCreditBalanceResponse(org.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(500);
    expect((thrown as ApiError).code).toBe("internal_error");
  });
});
