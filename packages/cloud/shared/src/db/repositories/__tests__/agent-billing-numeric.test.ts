/**
 * Fail-closed NUMERIC boundary for agent-billing organization `credit_balance`
 * reads (#13416, cloud-shared DB-repository fallback-slop sweep).
 *
 * Postgres NUMERIC arrives as a string. Before this slice the balance was read
 * through a bare `Number(...)`, so a corrupt value became `NaN` and downstream
 * consumers FAILED OPEN:
 *
 *   - `getOrganizationCreditBalance` returned `NaN` (not `null`) as an
 *     authoritative balance. The hourly-billing cron does
 *     `liveBalance = (await getOrgBalance(org)) ?? currentBalance` — `??` does
 *     NOT catch `NaN` — then gates on `liveBalance >= hourlyCost` and renders
 *     the value into the low-credit warning email/webhook as `$NaN`.
 *   - `recordHourlyBilling` derived the post-debit warning status from
 *     `newBalance < lowCreditWarningAmount ? "warning" : "active"`; a `NaN`
 *     balance makes that comparison always false, silently SUPPRESSING the
 *     low-credit "warning" status so the org keeps billing as "active" past its
 *     threshold with no signal.
 *
 * The parser suite pins the boundary exhaustively (deterministic, no DB). The
 * PGlite wiring test proves `getOrganizationCreditBalance` routes a real read
 * through the parser (healthy path) and returns `null` — not a fabricated 0 —
 * for a genuinely-missing org. A corrupt NUMERIC cannot be *stored* in
 * Postgres/PGlite, so the corrupt-read fail-closed behavior is proven at the
 * parser boundary the method calls (see the NaN-regression case below), which
 * is exactly the read-time driver-quirk / migration-artifact failure mode this
 * guards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// PGlite isolation harness (mirrors agent-billing-reactivation.test.ts): the
// wiring suite fails LOUDLY against a shared non-PGlite Postgres.
const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
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
    expect(Number("corrupt")).toBeNaN();
    expect(() => parseOrgCreditBalance("corrupt")).toThrow(/not a finite number/);
    expect(() => parseOrgCreditBalance("12.3.4")).toThrow(/not a finite number/);
    expect(() => parseOrgCreditBalance("Infinity")).toThrow(/not a finite number/);
    expect(() => parseOrgCreditBalance("NaN")).toThrow(/not a finite number/);
  });

  test("honors a caller-supplied field name in the error", () => {
    expect(() => parseOrgCreditBalance(null, "new_balance")).toThrow(/new_balance/);
  });
});

describe("AgentBillingRepository.getOrganizationCreditBalance fail-closed wiring", () => {
  const PGLITE_TIMEOUT = 60_000;
  let pgliteReady = true;

  let seq = 0;
  const uniq = (prefix: string): string => {
    seq += 1;
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[agent-billing-numeric.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite wiring suite fails — pushSchema against a shared connection crashes the bun runner and would mutate the shared schema. Parser suite above still runs.",
      );
      return;
    }
    try {
      const schema = { organizations };
      const { apply } = await pushSchema(schema as never, dbWrite as never);
      await apply();
    } catch (error) {
      pgliteReady = false;
      console.error(
        "[agent-billing-numeric.test] PGlite/pushSchema unavailable — cannot drive AgentBillingRepository against a real DB. Skipping wiring cases.",
        error,
      );
    }
  }, PGLITE_TIMEOUT);

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.delete(organizations);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("a real credit_balance read routes through the parser (healthy path)", async () => {
    expect(pgliteReady).toBe(true);
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Billing Org", slug: uniq("org"), credit_balance: "123.450000" })
      .returning();

    const balance = await agentBillingRepository.getOrganizationCreditBalance(org.id);
    expect(balance).toBe(123.45);
    expect(Number.isFinite(balance as number)).toBe(true);
  });

  test("a genuinely-missing org returns null — NOT a fabricated 0", async () => {
    expect(pgliteReady).toBe(true);
    const balance = await agentBillingRepository.getOrganizationCreditBalance(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(balance).toBeNull();
  });

  test("an explicit zero balance reads as 0, distinguishable from a missing org's null", async () => {
    expect(pgliteReady).toBe(true);
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Depleted Org", slug: uniq("org"), credit_balance: "0" })
      .returning();

    const balance = await agentBillingRepository.getOrganizationCreditBalance(org.id);
    expect(balance).toBe(0);
  });
});
