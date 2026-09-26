/**
 * Aggregate-width coverage for TrajectoriesService.getStats: the per-agent
 * step, call, and token totals are sums over INTEGER columns, and Postgres returns sum(integer)
 * as bigint. Narrowing that back to int raises "integer out of range" once an
 * agent's lifetime tokens pass 2^31-1, which turns GET /api/trajectories/stats
 * into a permanent 500. Real PGlite database, real service, real schema.
 *
 * The bigint aggregate width is a separate boundary from the public DTO's
 * JavaScript number precision: totals past Number.MAX_SAFE_INTEGER arrive as a
 * PGlite bigint or a node-postgres decimal string and must fail explicitly
 * rather than round. Those cases feed the stat reader real PGlite int8 cells.
 */

import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryHandleTrajectoryReadRoutes } from "./read-routes";
import {
  requiredSafeIntegerStat,
  TrajectoriesService,
} from "./TrajectoriesService";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa";
// Three rows of 800M each: the sum (2.4B) exceeds int32 while every row fits.
const PER_ROW = 800_000_000;

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let service: TrajectoriesService;
let server: Server;
let endpoint: string;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  const runtime = {
    agentId: AGENT_ID,
    adapter: { db },
    getService: (name: string) => (name === "trajectories" ? service : null),
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
  service = new TrajectoriesService(runtime);
  service.setEnabled(true);
  await service.initialize();
  for (let i = 0; i < 3; i += 1) {
    await db.execute(
      sql.raw(`
        INSERT INTO trajectories (
          id, agent_id, start_time, end_time, duration_ms, step_count, llm_call_count,
          total_prompt_tokens, total_completion_tokens,
          total_cache_read_input_tokens, total_cache_creation_input_tokens
        ) VALUES (
          'traj-${i}', '${AGENT_ID}', 1000, 2000, 1000, ${PER_ROW}, ${PER_ROW},
          ${PER_ROW}, ${PER_ROW}, ${PER_ROW}, ${PER_ROW}
        )
      `),
    );
  }
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void tryHandleTrajectoryReadRoutes({
      pathname: url.pathname,
      method: "GET",
      url,
      runtime,
      res: response,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  endpoint = `http://127.0.0.1:${address.port}/api/trajectories/stats`;
}, 60_000);

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await client.close();
});

describe("TrajectoriesService.getStats aggregate width", () => {
  it("reports lifetime token totals past 2^31-1 instead of throwing", async () => {
    const response = await fetch(endpoint);
    const stats = await response.json();
    expect(response.status, JSON.stringify(stats)).toBe(200);
    expect(stats.totalTrajectories).toBe(3);
    expect(stats.totalSteps).toBe(3 * PER_ROW);
    expect(stats.totalLlmCalls).toBe(3 * PER_ROW);
    expect(stats.totalPromptTokens).toBe(3 * PER_ROW);
    expect(stats.totalCompletionTokens).toBe(3 * PER_ROW);
    expect(stats.totalCacheReadInputTokens).toBe(3 * PER_ROW);
    expect(stats.totalCacheCreationInputTokens).toBe(3 * PER_ROW);
    expect(3 * PER_ROW).toBeGreaterThan(2 ** 31 - 1);
    expect(3 * PER_ROW).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

describe("requiredSafeIntegerStat JavaScript precision boundary", () => {
  async function int8Cells(): Promise<Record<string, unknown>> {
    const result = await db.execute(
      sql.raw(`
        SELECT
          ${3 * PER_ROW}::bigint AS wide,
          ${Number.MAX_SAFE_INTEGER}::bigint AS max_safe,
          (${Number.MAX_SAFE_INTEGER}::bigint + 2) AS past_safe
      `),
    );
    const [row] = (result as unknown as { rows: Record<string, unknown>[] })
      .rows;
    if (!row) throw new Error("Missing int8 probe row");
    return row;
  }

  it("returns bigint-width totals the public number represents exactly", async () => {
    const cells = await int8Cells();
    expect(typeof cells.wide).toBe("number");
    expect(requiredSafeIntegerStat(cells.wide as number, "total_steps")).toBe(
      3 * PER_ROW,
    );
    expect(
      requiredSafeIntegerStat(cells.max_safe as number, "total_steps"),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(requiredSafeIntegerStat("2400000000", "total_steps")).toBe(
      2_400_000_000,
    );
  });

  it("rejects totals past Number.MAX_SAFE_INTEGER instead of rounding them", async () => {
    const cells = await int8Cells();
    expect(typeof cells.past_safe).toBe("bigint");
    const precisionError = expect.objectContaining({
      code: "TRAJECTORY_STAT_PRECISION_EXCEEDED",
    });
    expect(() =>
      requiredSafeIntegerStat(cells.past_safe as bigint, "total_prompt_tokens"),
    ).toThrow(precisionError);
    expect(() =>
      requiredSafeIntegerStat("9007199254740993", "total_prompt_tokens"),
    ).toThrow(precisionError);
  });

  it("rejects missing, negative, fractional, and non-numeric cells", () => {
    const invalidRow = expect.objectContaining({
      code: "TRAJECTORY_ROW_INVALID",
    });
    for (const cell of [undefined, null, -1, 1.5, "-1", "1.5", "abc", ""]) {
      expect(() => requiredSafeIntegerStat(cell, "total_steps")).toThrow(
        invalidRow,
      );
    }
  });
});
