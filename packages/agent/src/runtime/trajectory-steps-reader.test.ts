/**
 * Unit coverage for the trajectory_steps CQRS reader: pagination clamps,
 * empty and single-step pages, ordinal ordering, count-row parsing, typed
 * storage failures, and loadAllStepsForTrajectory's follow-up paging loop.
 * Drives the real module through a stub runtime adapter that records SQL.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GET_STEPS_LIMIT,
  getSteps,
  loadAllStepsForTrajectory,
  MAX_GET_STEPS_LIMIT,
} from "./trajectory-steps-reader.ts";

const AGENT_ID = "agent-test";
const TRAJECTORY_ID = "traj-1";

function sqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (!query || typeof query !== "object") return String(query);
  const rec = query as {
    __sql?: unknown;
    sql?: unknown;
    queryChunks?: unknown;
  };
  if (typeof rec.__sql === "string") return rec.__sql;
  if (typeof rec.sql === "string") return rec.sql;
  const chunks = rec.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object") {
        const value = (chunk as { value?: unknown }).value;
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.join("");
      }
      return "";
    })
    .join("");
}

function runtimeWithExecute(
  execute: (sqlText: string) => unknown,
  overrides: Record<string, unknown> = {},
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    adapter: {
      db: {
        execute: async (query: unknown) => execute(sqlText(query)),
      },
    },
    logger: { warn: () => undefined },
    reportError: () => undefined,
    ...overrides,
  } as unknown as IAgentRuntime;
}

function validRow(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `step-${index}`,
    trajectory_id: TRAJECTORY_ID,
    ordinal: index,
    started_at: 1_000 + index,
    step_type: "llm",
    payload: { llmCalls: [], providerAccesses: [] },
    ...overrides,
  };
}

function parseLimitOffset(sql: string): { limit: number; offset: number } {
  const match = sql.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`missing LIMIT/OFFSET in: ${sql}`);
  }
  return { limit: Number(match[1]), offset: Number(match[2]) };
}

function pagingExecute(rows: Record<string, unknown>[]) {
  const sql: string[] = [];
  const execute = (text: string) => {
    sql.push(text);
    if (/count\(\*\)/i.test(text)) {
      return { rows: [{ total: rows.length }] };
    }
    const { limit, offset } = parseLimitOffset(text);
    return { rows: rows.slice(offset, offset + limit) };
  };
  return { sql, execute };
}

describe("trajectory-steps-reader constants", () => {
  it("exports the default page size and hard cap", () => {
    expect(DEFAULT_GET_STEPS_LIMIT).toBe(100);
    expect(MAX_GET_STEPS_LIMIT).toBe(1000);
  });
});

describe("getSteps storage availability", () => {
  it("throws TRAJECTORY_DATABASE_UNAVAILABLE when no adapter is present", async () => {
    const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    await expect(getSteps(runtime, TRAJECTORY_ID)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });

  it("throws when adapter.db.execute is missing", async () => {
    const runtime = {
      agentId: AGENT_ID,
      adapter: { db: {} },
    } as unknown as IAgentRuntime;
    await expect(getSteps(runtime, TRAJECTORY_ID)).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });

  it("reads through databaseAdapter.db when adapter.db is absent", async () => {
    const { execute } = pagingExecute([]);
    const runtime = {
      agentId: AGENT_ID,
      adapter: {},
      databaseAdapter: {
        db: {
          execute: async (query: unknown) => execute(sqlText(query)),
        },
      },
    } as unknown as IAgentRuntime;
    const page = await getSteps(runtime, TRAJECTORY_ID);
    expect(page).toEqual({
      steps: [],
      total: 0,
      offset: 0,
      limit: DEFAULT_GET_STEPS_LIMIT,
    });
  });
});

describe("getSteps trajectory id", () => {
  it("rejects empty and whitespace-only ids before querying", async () => {
    const sql: string[] = [];
    const runtime = runtimeWithExecute((text) => {
      sql.push(text);
      return { rows: [{ total: 0 }] };
    });
    await expect(getSteps(runtime, "")).rejects.toMatchObject({
      code: "TRAJECTORY_ID_INVALID",
    });
    await expect(getSteps(runtime, "   ")).rejects.toMatchObject({
      code: "TRAJECTORY_ID_INVALID",
    });
    await expect(getSteps(runtime, "\t\n")).rejects.toMatchObject({
      code: "TRAJECTORY_ID_INVALID",
    });
    expect(sql).toEqual([]);
  });

  it("trims surrounding whitespace and SQL-quotes apostrophes", async () => {
    const sql: string[] = [];
    const runtime = runtimeWithExecute((text) => {
      sql.push(text);
      return { rows: [{ total: 0 }] };
    });
    await getSteps(runtime, "  o'reilly  ");
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("s.trajectory_id = 'o''reilly'");
    expect(sql[0]).toContain(`t.agent_id = '${AGENT_ID}'`);
  });
});

describe("getSteps offset and limit clamps", () => {
  it("uses the default limit and zero offset when omitted", async () => {
    const page = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
    );
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(DEFAULT_GET_STEPS_LIMIT);
  });

  it("clamps a negative offset to 0 and truncates a fractional offset", async () => {
    const negative = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      -5,
      10,
    );
    expect(negative.offset).toBe(0);
    const truncated = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      2.9,
      10,
    );
    expect(truncated.offset).toBe(2);
  });

  it("raises a non-positive limit to 1", async () => {
    const zero = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      0,
      0,
    );
    expect(zero.limit).toBe(1);
    const negative = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      0,
      -3,
    );
    expect(negative.limit).toBe(1);
  });

  it("clamps an oversize limit to MAX_GET_STEPS_LIMIT", async () => {
    const page = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      0,
      999_999,
    );
    expect(page.limit).toBe(MAX_GET_STEPS_LIMIT);
    const atCap = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      0,
      MAX_GET_STEPS_LIMIT,
    );
    expect(atCap.limit).toBe(MAX_GET_STEPS_LIMIT);
  });

  it("truncates a fractional limit before clamping", async () => {
    const page = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      0,
      10.9,
    );
    expect(page.limit).toBe(10);
  });

  it("preserves NaN offset and limit after trunc/clamp", async () => {
    const page = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
      Number.NaN,
      Number.NaN,
    );
    expect(page.offset).toBeNaN();
    expect(page.limit).toBeNaN();
  });
});

describe("getSteps empty page", () => {
  it("returns an empty steps array and skips the list query when total is 0", async () => {
    const { sql, execute } = pagingExecute([]);
    const page = await getSteps(
      runtimeWithExecute(execute),
      TRAJECTORY_ID,
      4,
      25,
    );
    expect(page).toEqual({
      steps: [],
      total: 0,
      offset: 4,
      limit: 25,
    });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/count\(\*\)/i);
    expect(sql[0]).not.toMatch(/ORDER BY/i);
  });

  it("accepts a numeric-string zero total", async () => {
    const page = await getSteps(
      runtimeWithExecute(() => ({ rows: [{ total: "0" }] })),
      TRAJECTORY_ID,
    );
    expect(page.total).toBe(0);
    expect(page.steps).toEqual([]);
  });
});

describe("getSteps single element and ordering", () => {
  it("returns one persisted step from a well-formed row", async () => {
    const { execute } = pagingExecute([
      validRow(0, {
        step_type: "action",
        script: "console.log('ok');",
        payload: { llmCalls: [], providerAccesses: [] },
      }),
    ]);
    const page = await getSteps(runtimeWithExecute(execute), TRAJECTORY_ID);
    expect(page.total).toBe(1);
    expect(page.steps).toHaveLength(1);
    expect(page.steps[0]?.stepId).toBe("step-0");
    expect(page.steps[0]?.stepNumber).toBe(0);
    expect(page.steps[0]?.kind).toBe("action");
    expect(page.steps[0]?.script).toBe("console.log('ok');");
  });

  it("keeps ordinal order from the query result, including tied ordinals", async () => {
    const rows = [
      validRow(1, { id: "later", ordinal: 1 }),
      validRow(1, { id: "tied-first", ordinal: 1, started_at: 2_000 }),
      validRow(0, { id: "earlier", ordinal: 0 }),
    ];
    const sql: string[] = [];
    const execute = (text: string) => {
      sql.push(text);
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ total: rows.length }] };
      }
      return { rows };
    };
    const page = await getSteps(runtimeWithExecute(execute), TRAJECTORY_ID);
    expect(page.steps.map((step) => step.stepId)).toEqual([
      "later",
      "tied-first",
      "earlier",
    ]);
    expect(sql[1]).toMatch(/ORDER BY s\.ordinal ASC/);
  });

  it("slices by the LIMIT and OFFSET written into the list query", async () => {
    const rows = [validRow(0), validRow(1), validRow(2), validRow(3)];
    const { sql, execute } = pagingExecute(rows);
    const page = await getSteps(
      runtimeWithExecute(execute),
      TRAJECTORY_ID,
      1,
      2,
    );
    expect(page.total).toBe(4);
    expect(page.steps.map((step) => step.stepId)).toEqual(["step-1", "step-2"]);
    expect(sql[1]).toMatch(/LIMIT 2 OFFSET 1/);
  });

  it("returns no rows when offset is past the end of a non-empty trajectory", async () => {
    const { execute } = pagingExecute([validRow(0)]);
    const page = await getSteps(
      runtimeWithExecute(execute),
      TRAJECTORY_ID,
      10,
      5,
    );
    expect(page.total).toBe(1);
    expect(page.steps).toEqual([]);
    expect(page.offset).toBe(10);
  });
});

describe("getSteps count row parsing", () => {
  it("accepts a numeric-string total and still lists steps", async () => {
    const execute = (text: string) => {
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ total: "2" }] };
      }
      return { rows: [validRow(0), validRow(1)] };
    };
    const page = await getSteps(runtimeWithExecute(execute), TRAJECTORY_ID);
    expect(page.total).toBe(2);
    expect(page.steps).toHaveLength(2);
  });

  it("rejects a missing, blank, negative, or non-integer total", async () => {
    const invalidTotals = [undefined, null, "", "  ", -1, 1.5, "3.5", "nope"];
    for (const total of invalidTotals) {
      await expect(
        getSteps(
          runtimeWithExecute(() => ({ rows: [{ total }] })),
          TRAJECTORY_ID,
        ),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_STEP_ROW_INVALID",
        context: { trajectoryId: TRAJECTORY_ID, field: "total" },
      });
    }
  });

  it("rejects a count result that is not a row list", async () => {
    await expect(
      getSteps(
        runtimeWithExecute(() => ({ ok: true })),
        TRAJECTORY_ID,
      ),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_ROW_INVALID",
    });
  });

  it("rejects a count result whose rows array is empty", async () => {
    await expect(
      getSteps(
        runtimeWithExecute(() => ({ rows: [] })),
        TRAJECTORY_ID,
      ),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_STEP_ROW_INVALID",
      context: { trajectoryId: TRAJECTORY_ID, field: "total" },
    });
  });

  it("accepts a bare array result the same as { rows }", async () => {
    const page = await getSteps(
      runtimeWithExecute(() => [{ total: 0 }]),
      TRAJECTORY_ID,
    );
    expect(page.total).toBe(0);
  });
});

describe("getSteps row mapping failures", () => {
  it("throws TRAJECTORY_STEP_ROW_INVALID when a listed row is not a record", async () => {
    const execute = (text: string) => {
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ total: 1 }] };
      }
      return { rows: [null] };
    };
    await expect(
      getSteps(runtimeWithExecute(execute), TRAJECTORY_ID),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_STEP_ROW_INVALID",
      context: { trajectoryId: TRAJECTORY_ID, index: 0 },
    });
  });

  it("propagates stepRowToPersistedStep rejection for a malformed stored row", async () => {
    const execute = (text: string) => {
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          {
            id: "broken",
            trajectory_id: TRAJECTORY_ID,
            ordinal: 0,
            started_at: 1,
            step_type: "llm",
            payload: { llmCalls: [], providerAccesses: [] },
            parent_step_id: "",
          },
        ],
      };
    };
    await expect(
      getSteps(runtimeWithExecute(execute), TRAJECTORY_ID),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_STEP_ROW_INVALID",
    });
  });

  it("parses a JSON-string payload the same as an object payload", async () => {
    const execute = (text: string) => {
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          validRow(0, {
            payload: JSON.stringify({ llmCalls: [], providerAccesses: [] }),
          }),
        ],
      };
    };
    const page = await getSteps(runtimeWithExecute(execute), TRAJECTORY_ID);
    expect(page.steps[0]?.stepId).toBe("step-0");
    expect(page.steps[0]?.llmCalls).toEqual([]);
  });
});

describe("loadAllStepsForTrajectory", () => {
  it("returns an empty list when the owned trajectory has no dedicated steps", async () => {
    const all = await loadAllStepsForTrajectory(
      runtimeWithExecute(() => ({ rows: [{ total: 0 }] })),
      TRAJECTORY_ID,
    );
    expect(all).toEqual([]);
  });

  it("returns the first page when total fits in MAX_GET_STEPS_LIMIT", async () => {
    const rows = [validRow(0), validRow(1)];
    const { sql, execute } = pagingExecute(rows);
    const all = await loadAllStepsForTrajectory(
      runtimeWithExecute(execute),
      TRAJECTORY_ID,
    );
    expect(all.map((step) => step.stepId)).toEqual(["step-0", "step-1"]);
    expect(sql.filter((text) => /count\(\*\)/i.test(text))).toHaveLength(1);
    expect(sql[1]).toMatch(new RegExp(`LIMIT ${MAX_GET_STEPS_LIMIT} OFFSET 0`));
  });

  it("pages until offset covers total when more than MAX_GET_STEPS_LIMIT steps exist", async () => {
    const rows = Array.from({ length: MAX_GET_STEPS_LIMIT + 3 }, (_, index) =>
      validRow(index),
    );
    const { sql, execute } = pagingExecute(rows);
    const all = await loadAllStepsForTrajectory(
      runtimeWithExecute(execute),
      TRAJECTORY_ID,
    );
    expect(all).toHaveLength(MAX_GET_STEPS_LIMIT + 3);
    expect(all[0]?.stepId).toBe("step-0");
    expect(all[MAX_GET_STEPS_LIMIT]?.stepId).toBe(
      `step-${MAX_GET_STEPS_LIMIT}`,
    );
    expect(all.at(-1)?.stepId).toBe(`step-${MAX_GET_STEPS_LIMIT + 2}`);
    const listSql = sql.filter((text) => /ORDER BY s\.ordinal ASC/.test(text));
    expect(listSql).toHaveLength(2);
    expect(listSql[0]).toMatch(
      new RegExp(`LIMIT ${MAX_GET_STEPS_LIMIT} OFFSET 0`),
    );
    expect(listSql[1]).toMatch(
      new RegExp(`LIMIT ${MAX_GET_STEPS_LIMIT} OFFSET ${MAX_GET_STEPS_LIMIT}`),
    );
  });

  it("stops paging when a follow-up page returns no rows", async () => {
    let listCalls = 0;
    const execute = (text: string) => {
      if (/count\(\*\)/i.test(text)) {
        return { rows: [{ total: MAX_GET_STEPS_LIMIT + 5 }] };
      }
      listCalls += 1;
      if (listCalls === 1) {
        return {
          rows: Array.from({ length: MAX_GET_STEPS_LIMIT }, (_, index) =>
            validRow(index),
          ),
        };
      }
      return { rows: [] };
    };
    const all = await loadAllStepsForTrajectory(
      runtimeWithExecute(execute),
      TRAJECTORY_ID,
    );
    expect(all).toHaveLength(MAX_GET_STEPS_LIMIT);
    expect(listCalls).toBe(2);
  });

  it("propagates getSteps failures for a missing database", async () => {
    await expect(
      loadAllStepsForTrajectory(
        { agentId: AGENT_ID } as unknown as IAgentRuntime,
        TRAJECTORY_ID,
      ),
    ).rejects.toMatchObject({
      code: "TRAJECTORY_DATABASE_UNAVAILABLE",
    });
  });
});
