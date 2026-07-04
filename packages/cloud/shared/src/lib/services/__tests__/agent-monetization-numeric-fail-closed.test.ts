/**
 * #13415 — agent-monetization NUMERIC money-out fail-closed boundary.
 *
 * `getAgentMonetization` read `inference_markup_percentage` +
 * `total_creator_earnings` (Postgres NUMERIC → driver string) via a bare
 * `Number(...)`. Postgres accepts `'NaN'::numeric` as a valid value, so a
 * poisoned row reads back as the string `"NaN"` and `Number("NaN")` is `NaN`.
 * That NaN then poisoned every downstream consumer SILENTLY:
 *   - the service's own creator-markup math (`baseCost * (markup / 100)`) is
 *     `NaN` with no throw → a fabricated / garbage charge;
 *   - `getEarningsSummary` summed + sorted `NaN`, producing a garbage summary
 *     (every `NaN` comparison is `false`, so ranking is arbitrary);
 *   - the display route's `info?.totalEarnings || 0` collapsed the NaN into a
 *     fabricated healthy `$0` over a corrupt earnings ledger.
 *
 * The fix reads both NUMERIC values through `parseAgentMonetizationNumber`,
 * which THROWS on a corrupt/non-finite value (fail closed) while preserving an
 * explicit domain zero. These tests drive the parser directly (exhaustive
 * boundary + fail-open regressions) and the two real read sites via a stubbed
 * `dbRead`, proving a corrupt row now throws instead of returning NaN.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

// Stub the DB client's read query so the read sites resolve deterministic rows
// with no real Postgres. Only `dbRead.query.userCharacters.{findFirst,findMany}`
// is used by the two methods under test. The rest of the client's exports
// (`getDbConnectionInfo`, `dbWrite`, etc.) are spread from the real module so
// modules that import them at load still resolve.
import * as realDbClient from "../../../db/client";

let findFirstRow: Record<string, unknown> | null = null;
let findManyRows: Array<Record<string, unknown>> = [];

const findFirst = mock(async () => findFirstRow);
const findMany = mock(async () => findManyRows);

mock.module("../../../db/client", () => ({
  ...realDbClient,
  dbRead: {
    query: {
      userCharacters: { findFirst, findMany },
    },
  },
}));

// Not exercised on the read paths under test, but imported at module load.
mock.module("../credits", () => ({ creditsService: {} }));
mock.module("../redeemable-earnings", () => ({ redeemableEarningsService: {} }));
mock.module("../pricing", () => ({
  calculateCost: mock(async () => ({ totalCost: 0 })),
  estimateRequestCost: mock(async () => 0),
  getProviderFromModel: mock(() => "openai"),
}));

const {
  agentMonetizationService,
  parseAgentMonetizationNumber,
  CorruptAgentMonetizationNumberError,
} = await import("../agent-monetization");

const baseAgentRow = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  name: "Test Agent",
  user_id: "00000000-0000-4000-8000-00000000user",
  organization_id: "00000000-0000-4000-8000-0000000000org",
  monetization_enabled: true,
  inference_markup_percentage: "50.00",
  total_creator_earnings: "12.3400",
  total_inference_requests: 7,
  ...overrides,
});

beforeEach(() => {
  findFirstRow = null;
  findManyRows = [];
  findFirst.mockClear();
  findMany.mockClear();
});

describe("parseAgentMonetizationNumber (fail-closed boundary)", () => {
  test("parses valid NUMERIC strings and numbers", () => {
    expect(parseAgentMonetizationNumber("50.00", "inference_markup_percentage")).toBe(50);
    expect(parseAgentMonetizationNumber("12.3400", "total_creator_earnings")).toBeCloseTo(12.34, 6);
    expect(parseAgentMonetizationNumber(0, "x")).toBe(0);
    expect(parseAgentMonetizationNumber("0.00", "x")).toBe(0);
    expect(parseAgentMonetizationNumber(-5, "x")).toBe(-5); // domain values pass through unchanged
  });

  test("THROWS on the corrupt 'NaN'::numeric read (the fail-open regression)", () => {
    expect(() => parseAgentMonetizationNumber("NaN", "inference_markup_percentage")).toThrow(
      CorruptAgentMonetizationNumberError,
    );
    expect(() => parseAgentMonetizationNumber(Number.NaN, "x")).toThrow(
      CorruptAgentMonetizationNumberError,
    );
    // Proof of the pre-fix vulnerability: a bare Number("NaN") silently yields NaN.
    expect(Number("NaN")).toBeNaN();
  });

  test("THROWS on null/undefined/blank/non-finite/garbage", () => {
    for (const bad of [null, undefined, "", "   ", "abc", Number.POSITIVE_INFINITY, {}, []]) {
      expect(() => parseAgentMonetizationNumber(bad, "field")).toThrow(
        CorruptAgentMonetizationNumberError,
      );
    }
  });

  test("error names the field and raw value", () => {
    try {
      parseAgentMonetizationNumber("NaN", "total_creator_earnings");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptAgentMonetizationNumberError);
      const err = e as InstanceType<typeof CorruptAgentMonetizationNumberError>;
      expect(err.field).toBe("total_creator_earnings");
      expect(err.rawValue).toBe("NaN");
    }
  });
});

describe("getAgentMonetization (read-site wiring)", () => {
  test("healthy row parses markup + earnings through the boundary", async () => {
    findFirstRow = baseAgentRow();
    const info = await agentMonetizationService.getAgentMonetization("agent-1");
    expect(info).not.toBeNull();
    expect(info?.markupPercentage).toBe(50);
    expect(info?.totalEarnings).toBeCloseTo(12.34, 6);
    // Never NaN on a healthy read.
    expect(Number.isFinite(info?.markupPercentage ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(info?.totalEarnings ?? Number.NaN)).toBe(true);
  });

  test("corrupt inference_markup_percentage THROWS instead of returning NaN markup", async () => {
    findFirstRow = baseAgentRow({ inference_markup_percentage: "NaN" });
    await expect(agentMonetizationService.getAgentMonetization("agent-1")).rejects.toBeInstanceOf(
      CorruptAgentMonetizationNumberError,
    );
  });

  test("corrupt total_creator_earnings THROWS instead of returning NaN earnings", async () => {
    findFirstRow = baseAgentRow({ total_creator_earnings: "NaN" });
    await expect(agentMonetizationService.getAgentMonetization("agent-1")).rejects.toBeInstanceOf(
      CorruptAgentMonetizationNumberError,
    );
  });

  test("null markup (defensive) defaults to domain 0, does not throw", async () => {
    findFirstRow = baseAgentRow({ inference_markup_percentage: null });
    const info = await agentMonetizationService.getAgentMonetization("agent-1");
    expect(info?.markupPercentage).toBe(0);
  });

  test("missing agent returns null (unchanged)", async () => {
    findFirstRow = null;
    expect(await agentMonetizationService.getAgentMonetization("missing")).toBeNull();
  });
});

describe("getEarningsSummary (read-site wiring)", () => {
  test("healthy rows sum + rank without NaN poisoning", async () => {
    findManyRows = [
      baseAgentRow({ id: "a", total_creator_earnings: "10.0000" }),
      baseAgentRow({ id: "b", total_creator_earnings: "30.0000" }),
      baseAgentRow({ id: "c", total_creator_earnings: "20.0000", monetization_enabled: false }),
    ];
    const summary = await agentMonetizationService.getEarningsSummary("user-1");
    // c is not monetized → excluded.
    expect(summary.agentCount).toBe(2);
    expect(summary.totalAgentEarnings).toBeCloseTo(40, 6);
    // ranked descending by earnings — b (30) before a (10).
    expect(summary.topAgents.map((t) => t.id)).toEqual(["b", "a"]);
  });

  test("a single corrupt monetized row FAILS the summary closed (no NaN total)", async () => {
    findManyRows = [
      baseAgentRow({ id: "a", total_creator_earnings: "10.0000" }),
      baseAgentRow({ id: "poison", total_creator_earnings: "NaN" }),
    ];
    await expect(agentMonetizationService.getEarningsSummary("user-1")).rejects.toBeInstanceOf(
      CorruptAgentMonetizationNumberError,
    );
  });
});
