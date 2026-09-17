/**
 * Exercises agent-billing balance parsing and real PGlite read transitions.
 * Healthy, depleted, corrupt and missing balances remain distinct outcomes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { organizations } from "../../schemas/organizations";
import { agentBillingRepository } from "../agent-billing";
import { parseOrgCreditBalance } from "../agent-billing-numeric";

describe("parseOrgCreditBalance", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseOrgCreditBalance("25.00")).toBe(25);
    expect(parseOrgCreditBalance("100.500000")).toBe(100.5);
  });

  test("parses a numeric literal", () => {
    expect(parseOrgCreditBalance(0)).toBe(0);
    expect(parseOrgCreditBalance(42)).toBe(42);
  });

  test("allows an explicit domain zero (a legitimately depleted org)", () => {
    expect(parseOrgCreditBalance("0")).toBe(0);
    expect(parseOrgCreditBalance("0.000000")).toBe(0);
  });

  test("allows a negative balance (orgs can go negative between billing cycles)", () => {
    expect(parseOrgCreditBalance("-5.00")).toBe(-5);
  });

  test("throws on null / undefined instead of fabricating 0", () => {
    expect(() => parseOrgCreditBalance(null)).toThrow(/credit_balance/);
    expect(() => parseOrgCreditBalance(undefined)).toThrow(/empty or missing/);
  });

  test("throws on empty / whitespace-only instead of fabricating 0", () => {
    expect(() => parseOrgCreditBalance("")).toThrow(/empty or missing/);
    expect(() => parseOrgCreditBalance("   ")).toThrow(/empty or missing/);
  });

  test("REGRESSION: a corrupt value throws instead of becoming NaN (fail-open guard)", () => {
    // This is the exact class the billing paths used to swallow: `Number("corrupt")`
    // is NaN, `NaN >= hourlyCost` and `NaN < warningAmount` are both false — a
    // silently-open billing gate + suppressed low-credit warning.
    expect(() => parseOrgCreditBalance("corrupt")).toThrow(/not a finite number/);
    expect(() => parseOrgCreditBalance("12.3.4")).toThrow(/not a finite number/);
    expect(() => parseOrgCreditBalance("Infinity")).toThrow(/not a finite number/);
    expect(() => parseOrgCreditBalance("NaN")).toThrow(/not a finite number/);
  });

  test("honors a caller-supplied field name in the error", () => {
    expect(() => parseOrgCreditBalance(null, "new_balance")).toThrow(/new_balance/);
  });
});

describe("AgentBillingRepository.getOrganizationCreditBalance", () => {
  beforeAll(async () => {
    const { apply } = await pushSchema({ organizations } as never, dbWrite as never);
    await apply();
  }, 60_000);

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("reads healthy and zero balances, rejects stored NaN, and distinguishes deletion", async () => {
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Billing Org", slug: "agent-billing-balance", credit_balance: "123.450000" })
      .returning();
    expect(await agentBillingRepository.getOrganizationCreditBalance(org.id)).toBe(123.45);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "0" })
      .where(eq(organizations.id, org.id));
    expect(await agentBillingRepository.getOrganizationCreditBalance(org.id)).toBe(0);
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "NaN" })
      .where(eq(organizations.id, org.id));
    await expect(agentBillingRepository.getOrganizationCreditBalance(org.id)).rejects.toThrow(
      /Unable to read organization credit_balance/,
    );
    await dbWrite.delete(organizations).where(eq(organizations.id, org.id));
    expect(await agentBillingRepository.getOrganizationCreditBalance(org.id)).toBeNull();
  });
});
