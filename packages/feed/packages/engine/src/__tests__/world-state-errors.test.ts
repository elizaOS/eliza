/**
 * Error-path coverage for feed world-state reads and question outcomes.
 *
 * The DB module is replaced at the package boundary so these tests can force
 * query failures while still driving the real engine services.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockTable = Record<string, unknown> & { __name: string };

const tableResults = new Map<string, unknown[]>();
const failingTables = new Set<string>();
const insertValues = mock(async () => undefined);

function table(name: string): MockTable {
  return {
    __name: name,
    id: `${name}.id`,
    text: `${name}.text`,
    outcome: `${name}.outcome`,
    basePrice: `${name}.basePrice`,
    currentPrice: `${name}.currentPrice`,
    eventType: `${name}.eventType`,
    description: `${name}.description`,
    insiderActorIds: `${name}.insiderActorIds`,
    deceiverActorIds: `${name}.deceiverActorIds`,
    windowId: `${name}.windowId`,
  };
}

function rowsFor(tableName: string): unknown[] {
  if (failingTables.has(tableName)) {
    throw new Error(`${tableName} read failed`);
  }
  return tableResults.get(tableName) ?? [];
}

function selectBuilder() {
  return {
    from(source: MockTable) {
      const tableName = source.__name;
      const terminal = {
        limit: mock(async () => rowsFor(tableName)),
      };
      return {
        limit: terminal.limit,
        orderBy: mock(() => terminal),
        where: mock(() => terminal),
      };
    },
  };
}

const questions = table("questions");
const organizationState = table("organizationState");
const worldEvents = table("worldEvents");
const questionArcPlans = table("questionArcPlans");
const worldStateSnapshots = table("worldStateSnapshots");

mock.module("@feed/db", () => ({
  db: {
    insert: mock(() => ({ values: insertValues })),
    select: mock(() => selectBuilder()),
  },
  desc: mock((value: unknown) => value),
  eq: mock((left: unknown, right: unknown) => ({ left, right })),
  games: table("games"),
  generateSnowflakeId: mock(async () => "snapshot-1"),
  getDbInstance: mock(() => ({})),
  markets: table("markets"),
  questions,
  worldStateSnapshots,
}));

mock.module("@feed/db/schema", () => ({
  organizationState,
  questionArcPlans,
  questions,
  worldEvents,
}));

const { DatabaseError } = await import("@feed/shared");
const { gameService } = await import("../game-service");
const { WorldStateSnapshotService } = await import(
  "../services/world-state-snapshot-service"
);

beforeEach(() => {
  failingTables.clear();
  tableResults.clear();
  insertValues.mockClear();
});

describe("feed world-state database failures", () => {
  test("captureSnapshot throws instead of writing an empty world when a state query fails", async () => {
    failingTables.add("questions");

    await expect(
      WorldStateSnapshotService.captureSnapshot("window-1"),
    ).rejects.toBeInstanceOf(DatabaseError);
    await expect(
      WorldStateSnapshotService.captureSnapshot("window-1"),
    ).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      context: {
        operation: "WorldStateSnapshotService.getPredictionMarketState",
        originalError: "questions read failed",
      },
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  test("getQuestionOutcome preserves null for a reachable unresolved question", async () => {
    tableResults.set("questions", [{ outcome: null }]);

    await expect(
      gameService.getQuestionOutcome("market-1"),
    ).resolves.toBeNull();
  });

  test("getQuestionOutcome throws when the question query fails", async () => {
    failingTables.add("questions");

    await expect(
      gameService.getQuestionOutcome("market-1"),
    ).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      context: {
        operation: "GameService.getQuestionOutcome",
        originalError: "questions read failed",
      },
    });
  });
});
