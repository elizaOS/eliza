/**
 * Behavioral coverage for trajectory-query.ts. Drives the real
 * loadPersistedTrajectoryRows export through a hand-built runtime database
 * collaborator: missing storage, schema-init failure, empty and single-row
 * results, executor order (including created_at ties), LIMIT clamping,
 * agent_id quoting, invalid result envelopes, and parse-time row rejection.
 * The query module does not re-sort, remove, or wrap parsed rows — tests
 * assert those observed contracts.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { loadPersistedTrajectoryRows } from "./trajectory-query.ts";

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
    .queryChunks;
  if (!Array.isArray(chunks)) return String(value);
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .join("");
}

function isLoadQuery(sql: string): boolean {
  return (
    sql.includes("SELECT * FROM trajectories") &&
    sql.includes("ORDER BY created_at DESC LIMIT")
  );
}

function loadQuerySql(statements: readonly string[]): string {
  const sql = statements.find(isLoadQuery);
  if (!sql) {
    throw new Error(
      `load query was not issued; statements were: ${statements.join("\n")}`,
    );
  }
  return sql;
}

function loadLimitToken(statements: readonly string[]): string {
  const match = loadQuerySql(statements).match(
    /ORDER BY created_at DESC LIMIT (\S+)/,
  );
  if (!match) {
    throw new Error("load query did not include an ORDER BY/LIMIT clause");
  }
  return match[1];
}

function validRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "t1",
    agent_id: "agent-query-test",
    source: "runtime",
    status: "completed",
    start_time: 100,
    end_time: 150,
    duration_ms: 50,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.150Z",
    steps_json: "[]",
    metadata_json: "{}",
    metrics_json: "{}",
    reward_components_json: "{}",
    total_reward: 0,
    ...overrides,
  };
}

type ExecuteFn = (query: unknown) => Promise<unknown>;

function createHarness(
  options: {
    agentId?: string;
    includeTransaction?: boolean;
    adapter?: Record<string, unknown> | null;
    extraRuntime?: Record<string, unknown>;
  } = {},
): {
  runtime: IAgentRuntime;
  statements: string[];
  setSelectStarResult: (value: unknown) => void;
  setSelectStarError: (error: unknown) => void;
} {
  const statements: string[] = [];
  let selectStarResult: unknown = [];
  let selectStarError: unknown;

  const execute: ExecuteFn = async (query) => {
    const sql = sqlText(query);
    statements.push(sql);
    if (isLoadQuery(sql)) {
      if (selectStarError !== undefined) throw selectStarError;
      return selectStarResult;
    }
    return [];
  };

  const db: {
    execute: ExecuteFn;
    transaction?: <T>(
      work: (tx: { execute: ExecuteFn }) => Promise<T>,
    ) => Promise<T>;
  } = { execute };
  if (options.includeTransaction !== false) {
    db.transaction = async <T>(
      work: (tx: { execute: ExecuteFn }) => Promise<T>,
    ): Promise<T> => work({ execute });
  }

  const runtimeFields: Record<string, unknown> = {
    agentId: options.agentId ?? "agent-query-test",
    actions: [],
    logger: { warn: () => undefined },
    reportError: () => undefined,
    getSetting: () => undefined,
    getService: () => null,
    getServicesByType: () => [],
  };
  if (options.adapter === undefined) {
    runtimeFields.adapter = { db };
  } else if (options.adapter !== null) {
    runtimeFields.adapter = options.adapter;
  }
  Object.assign(runtimeFields, options.extraRuntime);

  return {
    runtime: runtimeFields as unknown as IAgentRuntime,
    statements,
    setSelectStarResult: (value) => {
      selectStarResult = value;
    },
    setSelectStarError: (error) => {
      selectStarError = error;
    },
  };
}

describe("loadPersistedTrajectoryRows", () => {
  it("throws TRAJECTORY_DATABASE_UNAVAILABLE when the runtime has no db", async () => {
    const runtime = {
      agentId: "agent-query-test",
      adapter: {},
      logger: { warn: () => undefined },
      reportError: () => undefined,
    } as unknown as IAgentRuntime;

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });

  it("throws TRAJECTORY_DATABASE_UNAVAILABLE when adapter.db has no execute", async () => {
    const runtime = {
      agentId: "agent-query-test",
      adapter: { db: {} },
      logger: { warn: () => undefined },
      reportError: () => undefined,
    } as unknown as IAgentRuntime;

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });

  it("propagates schema init failure when transactions are unavailable", async () => {
    const { runtime } = createHarness({ includeTransaction: false });

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_SCHEMA_INIT_FAILED",
    });
  });

  it("returns an empty array for an empty result set", async () => {
    const { runtime, statements } = createHarness();
    await expect(loadPersistedTrajectoryRows(runtime)).resolves.toEqual([]);
    expect(loadLimitToken(statements)).toBe("5000");
    expect(loadQuerySql(statements)).toContain(
      "WHERE agent_id = 'agent-query-test'",
    );
    expect(loadQuerySql(statements)).toContain("ORDER BY created_at DESC");
  });

  it("returns the same single row object the executor produced", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    const row = validRow();
    setSelectStarResult([row]);

    const result = await loadPersistedTrajectoryRows(runtime);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(row);
    expect(result[0]).toHaveProperty("start_time", 100);
    expect(result[0]).not.toHaveProperty("startTime");
  });

  it("preserves executor order, including created_at ties", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    const tied = "2026-01-01T00:00:00.000Z";
    const older = validRow({
      id: "older",
      created_at: "2025-12-31T00:00:00.000Z",
      updated_at: "2025-12-31T00:00:00.000Z",
    });
    const firstTie = validRow({
      id: "tie-a",
      created_at: tied,
      updated_at: tied,
    });
    const secondTie = validRow({
      id: "tie-b",
      created_at: tied,
      updated_at: tied,
    });
    setSelectStarResult([firstTie, secondTie, older]);

    const result = await loadPersistedTrajectoryRows(runtime);
    expect(result.map((row) => row.id)).toEqual(["tie-a", "tie-b", "older"]);
    expect(result[0]).toBe(firstTie);
    expect(result[1]).toBe(secondTie);
    expect(result[2]).toBe(older);
  });

  it("accepts a { rows } envelope as well as a bare array", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    const row = validRow({ id: "envelope-row" });
    setSelectStarResult({ rows: [row] });

    await expect(loadPersistedTrajectoryRows(runtime)).resolves.toEqual([row]);
  });

  it("clamps maxRows to [1, 10000] and truncates fractional values", async () => {
    const low = createHarness();
    await loadPersistedTrajectoryRows(low.runtime, 0);
    expect(loadLimitToken(low.statements)).toBe("1");

    const negative = createHarness();
    await loadPersistedTrajectoryRows(negative.runtime, -12);
    expect(loadLimitToken(negative.statements)).toBe("1");

    const fractional = createHarness();
    await loadPersistedTrajectoryRows(fractional.runtime, 3.9);
    expect(loadLimitToken(fractional.statements)).toBe("3");

    const exactMax = createHarness();
    await loadPersistedTrajectoryRows(exactMax.runtime, 10_000);
    expect(loadLimitToken(exactMax.statements)).toBe("10000");

    const overflow = createHarness();
    await loadPersistedTrajectoryRows(overflow.runtime, 10_001);
    expect(loadLimitToken(overflow.statements)).toBe("10000");

    const infinite = createHarness();
    await loadPersistedTrajectoryRows(
      infinite.runtime,
      Number.POSITIVE_INFINITY,
    );
    expect(loadLimitToken(infinite.statements)).toBe("10000");

    const negativeInfinite = createHarness();
    await loadPersistedTrajectoryRows(
      negativeInfinite.runtime,
      Number.NEGATIVE_INFINITY,
    );
    expect(loadLimitToken(negativeInfinite.statements)).toBe("1");
  });

  it("interpolates NaN into LIMIT when maxRows is NaN", async () => {
    const { runtime, statements } = createHarness();
    await loadPersistedTrajectoryRows(runtime, Number.NaN);
    expect(loadLimitToken(statements)).toBe("NaN");
  });

  it("sql-quotes agent_id, doubling embedded apostrophes", async () => {
    const { runtime, statements } = createHarness({
      agentId: "agent's-id",
    });
    await loadPersistedTrajectoryRows(runtime, 2);
    expect(loadQuerySql(statements)).toContain(
      "WHERE agent_id = 'agent''s-id'",
    );
    expect(loadLimitToken(statements)).toBe("2");
  });

  it("reads through databaseAdapter.db when adapter.db is absent", async () => {
    const statements: string[] = [];
    const row = validRow({ id: "legacy-adapter" });
    const execute: ExecuteFn = async (query) => {
      const sql = sqlText(query);
      statements.push(sql);
      if (isLoadQuery(sql)) return [row];
      return [];
    };
    const db = {
      execute,
      transaction: async <T>(
        work: (tx: { execute: ExecuteFn }) => Promise<T>,
      ): Promise<T> => work({ execute }),
    };
    const runtime = {
      agentId: "agent-query-test",
      adapter: {},
      databaseAdapter: { db },
      logger: { warn: () => undefined },
      reportError: () => undefined,
      getSetting: () => undefined,
      getService: () => null,
      getServicesByType: () => [],
    } as unknown as IAgentRuntime;

    await expect(loadPersistedTrajectoryRows(runtime)).resolves.toEqual([row]);
    expect(statements.some(isLoadQuery)).toBe(true);
  });

  it("prefers adapter.db over databaseAdapter.db", async () => {
    const winner = validRow({ id: "adapter-wins" });
    const { runtime, setSelectStarResult } = createHarness({
      extraRuntime: {
        databaseAdapter: {
          db: {
            execute: async () => {
              throw new Error("databaseAdapter.db must not be used");
            },
          },
        },
      },
    });
    setSelectStarResult([winner]);
    await expect(loadPersistedTrajectoryRows(runtime)).resolves.toEqual([
      winner,
    ]);
  });

  it("rejects a non-row query envelope as TRAJECTORY_ROW_INVALID", async () => {
    const missingRows = createHarness();
    missingRows.setSelectStarResult({});
    await expect(
      loadPersistedTrajectoryRows(missingRows.runtime),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: {
        operation: "load trajectory rows",
        agentId: "agent-query-test",
      },
    });

    const nullRows = createHarness();
    nullRows.setSelectStarResult({ rows: null });
    await expect(
      loadPersistedTrajectoryRows(nullRows.runtime),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
    });
  });

  it("rejects a non-record row and reports its index", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    setSelectStarResult([validRow(), null]);

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: { index: 1 },
    });
  });

  it("rejects array, primitive, and missing rows at asRecord", async () => {
    const arrayRow = createHarness();
    arrayRow.setSelectStarResult([["not", "a", "record"]]);
    await expect(
      loadPersistedTrajectoryRows(arrayRow.runtime),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: { index: 0 },
    });

    const primitive = createHarness();
    primitive.setSelectStarResult(["row"]);
    await expect(
      loadPersistedTrajectoryRows(primitive.runtime),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: { index: 0 },
    });
  });

  it("propagates parsePersistedTrajectoryRow rejection for a well-shaped invalid row", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    setSelectStarResult([
      validRow({
        status: "active",
        end_time: 150,
        duration_ms: 50,
      }),
    ]);

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: { field: "end_time/duration_ms", trajectoryId: "t1" },
    });
  });

  it("uses fallback id unknown when the row id is not a string", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    setSelectStarResult([validRow({ id: 42 })]);

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: { field: "id", trajectoryId: "unknown" },
    });
  });

  it("does not fall through to trajectory_id when id is present but not a string", async () => {
    const { runtime, setSelectStarResult } = createHarness();
    setSelectStarResult([
      validRow({
        id: 7,
        trajectory_id: "from-trajectory-id",
      }),
    ]);

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
      context: { field: "id", trajectoryId: "unknown" },
    });
  });

  it("propagates a post-schema execute failure without wrapping it", async () => {
    const { runtime, setSelectStarError } = createHarness();
    await loadPersistedTrajectoryRows(runtime);
    const boom = new Error("select failed");
    setSelectStarError(boom);

    await expect(loadPersistedTrajectoryRows(runtime)).rejects.toBe(boom);
  });
});
