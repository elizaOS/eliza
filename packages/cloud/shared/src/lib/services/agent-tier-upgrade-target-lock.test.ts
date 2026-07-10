/**
 * Discriminating regression test for the tier-upgrade single-flight SPAN
 * (#15943). Single-connection PGlite serializes every statement, so the
 * behavioral suite in `agent-tier-upgrade-target.test.ts` passes identically
 * whether the advisory lock is present, moved, or the provision enqueue is
 * hoisted back out of the transaction — it cannot catch the exact regression
 * #15929 shipped (lock released at the target commit, enqueue left outside).
 *
 * This suite closes that gap the way `inference-billing-ledger-advisory-lock`
 * does for its lock: it mocks ONLY the transaction seam, records every
 * statement each transaction runs, and asserts the boundary transaction takes
 * the per-source tier-upgrade lock FIRST, re-checks for a live target under
 * it, and inserts the target AND its provision job (behind the nested
 * per-agent provision lock) before committing. Move the enqueue outside the
 * transaction, drop either lock, or reorder the re-check, and this fails.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as helpersActual from "../../db/helpers";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import * as loggerActual from "../utils/logger";
import * as apiKeysActual from "./api-keys";
import * as managedConfigActual from "./managed-eliza-config";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const SRC = "cccccccc-1111-4111-8111-111111111111";
const WINNER_TARGET_ID = "eeeeeeee-1111-4111-8111-111111111111";

interface TxEvent {
  tx: number;
  kind: string;
  detail?: string;
}

type SandboxRow = Record<string, unknown>;

const events: TxEvent[] = [];
let txCounter = 0;
/** What the live-target re-check returns, per transaction index — lets the
 * race-loser test show a competitor's commit between phase 1 and phase 3. */
let liveTargetRowsForTx: (txIndex: number) => SandboxRow[] = () => [];
let insertedTarget: SandboxRow | undefined;
let prepCalls = 0;
const revokeForAgent = mock(async (_agentSandboxId: string) => {});

function makeTx(txIndex: number) {
  return {
    execute: async (query: SQL) => {
      const { sql: text, params } = new PgDialect().sqlToQuery(query);
      if (text.includes("pg_advisory_xact_lock")) {
        events.push({ tx: txIndex, kind: "lock", detail: String(params[1] ?? "") });
      } else {
        events.push({ tx: txIndex, kind: "execute" });
      }
      return { rows: [] };
    },
    select: () => {
      const state = { table: undefined as unknown, hasOrderBy: false };
      const chain = {
        from: (table: unknown) => {
          state.table = table;
          return chain;
        },
        where: (_clause: SQL | undefined) => chain,
        orderBy: () => {
          state.hasOrderBy = true;
          return chain;
        },
        limit: () => {
          // The live-target re-check orders by created_at; the enqueue's
          // sandbox-existence probe does not — that distinguishes them.
          if (state.table === agentSandboxes && state.hasOrderBy) {
            events.push({ tx: txIndex, kind: "select-live-target" });
            return liveTargetRowsForTx(txIndex);
          }
          if (state.table === agentSandboxes) {
            events.push({ tx: txIndex, kind: "select-sandbox-for-enqueue" });
            return insertedTarget ? [insertedTarget] : [];
          }
          events.push({ tx: txIndex, kind: "select-active-job" });
          return [];
        },
        // biome-ignore lint/suspicious/noThenProperty: Drizzle's count chain is awaited at `.where()`, so this mock must be thenable.
        then: (resolve: (rows: Array<{ count: number }>) => unknown) => {
          events.push({ tx: txIndex, kind: "select-quota-count" });
          return resolve([{ count: 0 }]);
        },
      };
      return chain;
    },
    insert: (table: unknown) => ({
      values: (value: SandboxRow) => ({
        returning: async () => {
          if (table === agentSandboxes) {
            events.push({ tx: txIndex, kind: "insert-target" });
            insertedTarget = { updated_at: new Date(), ...value };
            return [insertedTarget];
          }
          events.push({ tx: txIndex, kind: "insert-provision-job" });
          return [{ ...value }];
        },
      }),
    }),
  };
}

const transaction = mock(async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
  txCounter += 1;
  return fn(makeTx(txCounter));
});

// VALUE snapshots taken at module evaluation, while no mock is installed.
// `db/helpers` re-exports `dbWrite` from `db/client`, so bun's module mocks
// patch the SHARED live binding — a restore built from the live namespace
// would re-capture the mock. Snapshot objects freeze the original references.
const helpersSnapshot = { ...helpersActual };
const managedConfigSnapshot = { ...managedConfigActual };
const apiKeysSnapshot = { ...apiKeysActual };
const loggerSnapshot = { ...loggerActual };

let createTierUpgradeTargetWithProvision: typeof import("./agent-tier-upgrade-target").createTierUpgradeTargetWithProvision;

// Mocks are installed in beforeAll — NEVER at module scope: `bun test`
// evaluates every test file's module scope up front, so a module-scope mock
// would clobber the shared bindings under every OTHER suite in a multi-file
// run (the coverage lane co-runs all changed suites in one process, #15943).
beforeAll(async () => {
  mock.module("../../db/helpers", () => ({
    ...helpersSnapshot,
    dbWrite: { transaction },
    writeTransaction: (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => transaction(fn),
  }));

  // Spread the snapshot so the module's OTHER named exports (consumed by
  // transitive importers like eliza-managed-launch) still resolve — a partial
  // mock.module throws "Export not found" at link time.
  mock.module("./managed-eliza-config", () => ({
    ...managedConfigSnapshot,
    prepareManagedElizaSharedEnvironment: async (params: { agentSandboxId: string }) => {
      prepCalls += 1;
      return {
        apiToken: "agent_locktest",
        changed: true,
        environmentVars: {
          ELIZA_API_TOKEN: "agent_locktest",
          ELIZA_CLOUD_AGENT_ID: params.agentSandboxId,
        },
        agentApiKey: "ek_locktest",
      };
    },
  }));

  mock.module("./api-keys", () => ({
    ...apiKeysSnapshot,
    apiKeysService: { revokeForAgent },
  }));

  mock.module("../utils/logger", () => ({
    ...loggerSnapshot,
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
  }));

  ({ createTierUpgradeTargetWithProvision } = await import("./agent-tier-upgrade-target"));
});

// Hand the pristine modules back to whatever test file runs after this one in
// the same process — a leaked module mock patches itself into later suites'
// imports.
afterAll(() => {
  mock.module("../../db/helpers", () => helpersSnapshot);
  mock.module("./managed-eliza-config", () => managedConfigSnapshot);
  mock.module("./api-keys", () => apiKeysSnapshot);
  mock.module("../utils/logger", () => loggerSnapshot);
});

afterEach(() => {
  events.length = 0;
  txCounter = 0;
  liveTargetRowsForTx = () => [];
  insertedTarget = undefined;
  prepCalls = 0;
  transaction.mockClear();
  revokeForAgent.mockClear();
});

function upgrade() {
  return createTierUpgradeTargetWithProvision({
    sourceAgentId: SRC,
    organizationId: ORG,
    userId: USER,
    agentName: "lock-span-target",
    environmentVars: {},
    maxNonTerminalAgents: 5,
  });
}

describe("tier-upgrade single-flight span (#15943)", () => {
  test("the boundary transaction spans lock → re-check → target insert → provision lock → job insert", async () => {
    const result = await upgrade();
    expect(result.created).toBe(true);

    // Exactly two transactions: the phase-1 pre-check and the phase-3 boundary.
    expect(txCounter).toBe(2);

    const phase1 = events.filter((event) => event.tx === 1);
    expect(phase1.map((event) => event.kind)).toEqual([
      "lock",
      "lock",
      "select-live-target",
      "select-quota-count",
    ]);
    // Global lock order: the ORG-WIDE agent-create lock is acquired FIRST
    // (quota atomicity against createAgent and other-source upgrades,
    // #16042 review), then the per-source tier-upgrade lock.
    expect(phase1[0]?.detail).toBe("agent-create");
    expect(phase1[1]?.detail).toBe(`tier-upgrade:${SRC}`);

    // The load-bearing assertion: target insert AND provision-job insert are
    // statements of the SAME transaction that took the org + tier-upgrade
    // locks as its first statements. Hoist the enqueue out of the transaction
    // and the job insert disappears from this list; release or reorder the
    // locks and the head of the list changes.
    const phase3 = events.filter((event) => event.tx === 2);
    expect(phase3.map((event) => event.kind)).toEqual([
      "lock",
      "lock",
      "select-live-target",
      "select-quota-count",
      "insert-target",
      "lock",
      "select-sandbox-for-enqueue",
      "select-active-job",
      "insert-provision-job",
    ]);
    expect(phase3[0]?.detail).toBe("agent-create");
    expect(phase3[1]?.detail).toBe(`tier-upgrade:${SRC}`);
    // The nested provision lock is keyed on the freshly minted target id
    // (org → tier-upgrade → provision; never any other order).
    expect(phase3[5]?.detail).toBe(result.agent.id);

    // Happy path: the prepared credentials were adopted, not revoked.
    expect(prepCalls).toBe(1);
    expect(revokeForAgent).not.toHaveBeenCalled();
  });

  test("a live target found under the phase-1 lock reattaches without preparing or opening the boundary", async () => {
    liveTargetRowsForTx = () => [
      {
        id: WINNER_TARGET_ID,
        organization_id: ORG,
        execution_tier: "dedicated-always",
        status: "pending",
        agent_config: { __agentUpgradedFrom: SRC },
      },
    ];

    const result = await upgrade();
    expect(result.created).toBe(false);
    // One transaction only — no preparation, no candidate credentials to revoke.
    expect(txCounter).toBe(1);
    expect(prepCalls).toBe(0);
    expect(revokeForAgent).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toEqual(["lock", "lock", "select-live-target"]);
  });

  test("losing the race inside the boundary revokes the candidate credentials and adopts the winner's target", async () => {
    // Phase 1 sees nothing; the boundary re-check finds a competitor's target
    // committed in the window between the two transactions.
    liveTargetRowsForTx = (txIndex) =>
      txIndex >= 2
        ? [
            {
              id: WINNER_TARGET_ID,
              organization_id: ORG,
              execution_tier: "dedicated-always",
              status: "pending",
              agent_config: { __agentUpgradedFrom: SRC },
            },
          ]
        : [];

    const result = await upgrade();
    expect(result.created).toBe(false);
    expect(result.agent.id).toBe(WINNER_TARGET_ID);

    // The loser prepared once, made nothing durable, and dropped its own
    // candidate key — never the winner's (the revoke is keyed on the loser's
    // prospective id, which is not the winner's target id).
    expect(prepCalls).toBe(1);
    expect(events.filter((event) => event.kind === "insert-target")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "insert-provision-job")).toHaveLength(0);
    expect(revokeForAgent).toHaveBeenCalledTimes(1);
    const revokedId = revokeForAgent.mock.calls[0]?.[0];
    expect(revokedId).toBeTruthy();
    expect(revokedId).not.toBe(WINNER_TARGET_ID);
  });
});
