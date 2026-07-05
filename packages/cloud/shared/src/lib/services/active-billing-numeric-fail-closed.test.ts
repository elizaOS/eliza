/**
 * #13415 — active-billing display + credit-ledger NUMERIC fail-closed boundary.
 *
 * `listActiveResources` and `listLedger` read Postgres NUMERIC columns
 * (`containers.total_billed`, `agent_sandboxes.total_billed`,
 * `agent_sandboxes.hourly_rate`, `credit_transactions.amount`) via a bare
 * `Number(...)`. Postgres accepts `'NaN'::numeric` as a valid stored value that
 * reads back as the string `"NaN"`, so a corrupt row coerced to `NaN` SILENTLY:
 *   - renders a fabricated "$NaN billed" line in the billing panel
 *     (`totalBilled` / `hourlyRate`);
 *   - poisons the `amount` in the credit-transaction ledger a user reads to
 *     RECONCILE what they were actually charged.
 *
 * The fix reads every NUMERIC value through `parseActiveBillingNumber`, which
 * THROWS on a corrupt/non-finite value (fail closed → clean 500 at the route's
 * existing try/catch → failureResponse) while preserving an explicit domain
 * zero. These tests drive the parser directly (exhaustive boundary +
 * reversion-proof fail-open regressions) and the two display read sites via a
 * stubbed `dbRead`, proving a corrupt row now throws instead of fabricating a
 * NaN billing figure.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

// ── Stub dbRead's drizzle query builder ──────────────────────────────────────
// `listActiveResources` runs `dbRead.select().from(containers|agentSandboxes).where(...)`
// (awaited → array). `listLedger` runs `.select().from(creditTransactions).where().orderBy().limit(...)`
// (awaited → array). We route the awaited result on the *table* passed to `.from()`.
import * as realDbClient from "../../db/client";

let containerRows: Array<Record<string, unknown>> = [];
let agentRows: Array<Record<string, unknown>> = [];
let ledgerRows: Array<Record<string, unknown>> = [];
let dbWriteUpdateCalls = 0;
let containerInfrastructureCalls = 0;
let agentInfrastructureCalls = 0;

// Identify which fixture a `.from(table)` call wants without importing the real
// drizzle table objects: the schema modules export named tables, and the real
// service imports the same objects, so we compare by reference.
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";
import { creditTransactions } from "../../db/schemas/credit-transactions";

// A drizzle-shaped builder. `.where()` returns a Promise (awaitable directly for
// `listActiveResources`) that ALSO carries `.orderBy()/.limit()` so the
// `listLedger` chain (`.where().orderBy().limit()`) resolves. Attaching the
// chain methods onto the Promise avoids a bare `then` property on a plain object
// (which biome's noThenProperty flags) while matching both real call shapes.
function whereResult(
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const p = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & {
    orderBy: () => typeof p;
    limit: () => Promise<Array<Record<string, unknown>>>;
  };
  p.orderBy = () => p;
  p.limit = () => Promise.resolve(rows);
  return p;
}

function makeBuilder() {
  let rows: Array<Record<string, unknown>> = [];
  const builder = {
    select() {
      return builder;
    },
    from(table: unknown) {
      if (table === containers) rows = containerRows;
      else if (table === agentSandboxes) rows = agentRows;
      else if (table === creditTransactions) rows = ledgerRows;
      else rows = [];
      return builder;
    },
    where() {
      return whereResult(rows);
    },
  };
  return builder;
}

mock.module("../../db/client", () => ({
  ...realDbClient,
  dbRead: {
    select: () => makeBuilder(),
  },
  dbWrite: {
    update() {
      dbWriteUpdateCalls += 1;
      const builder = {
        set() {
          return builder;
        },
        where() {
          return builder;
        },
        returning() {
          return Promise.resolve([...containerRows, ...agentRows]);
        },
      };
      return builder;
    },
  },
}));

mock.module("./containers/hetzner-client", () => ({
  getHetznerContainersClient: () => ({
    stopContainer: async () => {
      containerInfrastructureCalls += 1;
    },
    deleteContainer: async () => {
      containerInfrastructureCalls += 1;
    },
  }),
}));

mock.module("./provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentSuspendOnce: async () => {
      agentInfrastructureCalls += 1;
    },
    enqueueAgentDeleteOnce: async () => {
      agentInfrastructureCalls += 1;
    },
    triggerImmediate: async () => {},
  },
}));

const { activeBillingService } = await import("./active-billing");
const {
  parseActiveBillingNonNegativeNumber,
  parseActiveBillingNumber,
  CorruptActiveBillingNumberError,
} = await import("./active-billing-numeric");

const ORG = "00000000-0000-4000-8000-0000000000org";

const baseContainer = (overrides: Record<string, unknown> = {}) => ({
  id: "container-1",
  name: "app",
  project_name: "proj",
  organization_id: ORG,
  status: "running",
  billing_status: "active",
  desired_count: 1,
  cpu: 1,
  memory: 512,
  total_billed: "12.50",
  last_billed_at: null,
  next_billing_at: null,
  scheduled_shutdown_at: null,
  public_hostname: null,
  load_balancer_url: null,
  metadata: {},
  ...overrides,
});

const baseAgent = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-100000",
  agent_name: "Bot",
  organization_id: ORG,
  status: "running",
  billing_status: "active",
  total_billed: "3.00",
  hourly_rate: "0.0100",
  character_id: "char-1",
  sandbox_id: "sbx-1",
  bridge_url: null,
  last_billed_at: null,
  last_backup_at: null,
  scheduled_shutdown_at: null,
  execution_tier: "dedicated",
  ...overrides,
});

const baseLedgerRow = (overrides: Record<string, unknown> = {}) => ({
  id: "tx-1",
  amount: "1.500000",
  type: "debit",
  description: "usage",
  created_at: new Date("2026-07-05T00:00:00.000Z"),
  metadata: { billing_type: "usage" },
  ...overrides,
});

beforeEach(() => {
  containerRows = [];
  agentRows = [];
  ledgerRows = [];
  dbWriteUpdateCalls = 0;
  containerInfrastructureCalls = 0;
  agentInfrastructureCalls = 0;
});

// ── Parser boundary (exhaustive) ─────────────────────────────────────────────
describe("parseActiveBillingNumber", () => {
  test("parses a normal numeric string", () => {
    expect(parseActiveBillingNumber("12.50", "f")).toBe(12.5);
  });

  test("parses a numeric value", () => {
    expect(parseActiveBillingNumber(7, "f")).toBe(7);
  });

  test("allows explicit domain zero", () => {
    expect(parseActiveBillingNumber("0.00", "f")).toBe(0);
    expect(parseActiveBillingNumber(0, "f")).toBe(0);
  });

  test("allows negative (e.g. a credit/refund amount)", () => {
    expect(parseActiveBillingNumber("-4.25", "f")).toBe(-4.25);
  });

  test("non-negative parser rejects negative totals/rates", () => {
    expect(() => parseActiveBillingNonNegativeNumber("-4.25", "total_billed")).toThrow(
      CorruptActiveBillingNumberError,
    );
  });

  test("THROWS on the 'NaN' string (poisoned NUMERIC read-back) — fail-open regression", () => {
    expect(() => parseActiveBillingNumber("NaN", "total_billed")).toThrow(
      CorruptActiveBillingNumberError,
    );
  });

  test("THROWS on Infinity", () => {
    expect(() => parseActiveBillingNumber("Infinity", "f")).toThrow(
      CorruptActiveBillingNumberError,
    );
    expect(() => parseActiveBillingNumber(Number.POSITIVE_INFINITY, "f")).toThrow(
      CorruptActiveBillingNumberError,
    );
  });

  test("THROWS on null / undefined / empty / whitespace", () => {
    expect(() => parseActiveBillingNumber(null, "f")).toThrow(CorruptActiveBillingNumberError);
    expect(() => parseActiveBillingNumber(undefined, "f")).toThrow(CorruptActiveBillingNumberError);
    expect(() => parseActiveBillingNumber("", "f")).toThrow(CorruptActiveBillingNumberError);
    expect(() => parseActiveBillingNumber("   ", "f")).toThrow(CorruptActiveBillingNumberError);
  });

  test("THROWS on non-numeric garbage", () => {
    expect(() => parseActiveBillingNumber("abc", "f")).toThrow(CorruptActiveBillingNumberError);
  });

  test("error names the field and raw value", () => {
    try {
      parseActiveBillingNumber("NaN", "credit_transaction.amount");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptActiveBillingNumberError);
      expect((e as Error).message).toContain("credit_transaction.amount");
      expect((e as Error).message).toContain("NaN");
      expect((e as CorruptActiveBillingNumberError).code).toBe("CORRUPT_ACTIVE_BILLING_NUMBER");
      expect((e as CorruptActiveBillingNumberError).context).toEqual({
        fieldName: "credit_transaction.amount",
        rawValue: "NaN",
      });
      expect((e as CorruptActiveBillingNumberError).severity).toBe("fatal");
    }
  });
});

// ── listActiveResources seam ─────────────────────────────────────────────────
describe("listActiveResources fail-closed", () => {
  test("healthy container + agent rows render real totals", async () => {
    containerRows = [baseContainer()];
    agentRows = [baseAgent()];
    const out = await activeBillingService.listActiveResources(ORG);
    const container = out.find((r) => r.resourceType === "container");
    const agent = out.find((r) => r.resourceType === "agent_sandbox");
    expect(container?.totalBilled).toBe(12.5);
    expect(agent?.totalBilled).toBe(3);
    expect(agent?.metadata.hourlyRate).toBe(0.01);
  });

  test("explicit-zero total_billed is a legit domain value, not corruption", async () => {
    containerRows = [baseContainer({ total_billed: "0.00" })];
    const out = await activeBillingService.listActiveResources(ORG);
    expect(out[0].totalBilled).toBe(0);
  });

  test("null hourly_rate falls back to computed unitPrice (no throw)", async () => {
    agentRows = [baseAgent({ hourly_rate: null })];
    const out = await activeBillingService.listActiveResources(ORG);
    // running agent → RUNNING_HOURLY_RATE (0.01)
    expect(out[0].metadata.hourlyRate).toBe(0.01);
  });

  test("corrupt container.total_billed THROWS instead of fabricating $NaN", async () => {
    containerRows = [baseContainer({ total_billed: "NaN" })];
    await expect(activeBillingService.listActiveResources(ORG)).rejects.toBeInstanceOf(
      CorruptActiveBillingNumberError,
    );
  });

  test("negative container.total_billed THROWS instead of rendering a negative billed total", async () => {
    containerRows = [baseContainer({ total_billed: "-1.00" })];
    await expect(activeBillingService.listActiveResources(ORG)).rejects.toBeInstanceOf(
      CorruptActiveBillingNumberError,
    );
  });

  test("corrupt agent.total_billed THROWS", async () => {
    agentRows = [baseAgent({ total_billed: "NaN" })];
    await expect(activeBillingService.listActiveResources(ORG)).rejects.toBeInstanceOf(
      CorruptActiveBillingNumberError,
    );
  });

  test("corrupt agent.hourly_rate THROWS (not silently NaN in metadata)", async () => {
    agentRows = [baseAgent({ hourly_rate: "NaN" })];
    await expect(activeBillingService.listActiveResources(ORG)).rejects.toBeInstanceOf(
      CorruptActiveBillingNumberError,
    );
  });

  test("negative agent.hourly_rate THROWS instead of rendering a negative rate", async () => {
    agentRows = [baseAgent({ hourly_rate: "-0.0100" })];
    await expect(activeBillingService.listActiveResources(ORG)).rejects.toBeInstanceOf(
      CorruptActiveBillingNumberError,
    );
  });
});

// ── listLedger seam ──────────────────────────────────────────────────────────
describe("listLedger fail-closed", () => {
  test("healthy ledger rows render real reconciliation amounts", async () => {
    ledgerRows = [baseLedgerRow({ amount: "2.250000" })];
    const out = await activeBillingService.listLedger(ORG);
    expect(out[0].amount).toBe(2.25);
  });

  test("explicit-zero amount is legit", async () => {
    ledgerRows = [baseLedgerRow({ amount: "0.000000" })];
    const out = await activeBillingService.listLedger(ORG);
    expect(out[0].amount).toBe(0);
  });

  test("negative ledger amount remains legitimate for signed reconciliation rows", async () => {
    ledgerRows = [baseLedgerRow({ amount: "-1.500000" })];
    const out = await activeBillingService.listLedger(ORG);
    expect(out[0].amount).toBe(-1.5);
  });

  test("corrupt ledger amount THROWS instead of poisoning the reconciliation view", async () => {
    ledgerRows = [baseLedgerRow({ amount: "NaN" })];
    await expect(activeBillingService.listLedger(ORG)).rejects.toBeInstanceOf(
      CorruptActiveBillingNumberError,
    );
  });
});

// ── cancelResource pre-mutation gate ────────────────────────────────────────
describe("cancelResource fail-closed before side effects", () => {
  test("corrupt container.total_billed throws before infra stop or billing suspension", async () => {
    containerRows = [baseContainer({ total_billed: "NaN" })];

    await expect(
      activeBillingService.cancelResource({
        organizationId: ORG,
        resourceId: "container-1",
        resourceType: "container",
      }),
    ).rejects.toBeInstanceOf(CorruptActiveBillingNumberError);

    expect(containerInfrastructureCalls).toBe(0);
    expect(dbWriteUpdateCalls).toBe(0);
  });

  test("corrupt agent_sandbox.total_billed throws before enqueueing infra or suspending billing", async () => {
    agentRows = [baseAgent({ total_billed: "NaN" })];

    await expect(
      activeBillingService.cancelResource({
        organizationId: ORG,
        resourceId: "agent-100000",
        resourceType: "agent_sandbox",
      }),
    ).rejects.toBeInstanceOf(CorruptActiveBillingNumberError);

    expect(agentInfrastructureCalls).toBe(0);
    expect(dbWriteUpdateCalls).toBe(0);
  });
});
