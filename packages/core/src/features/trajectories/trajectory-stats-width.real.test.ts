/**
 * Aggregate-width coverage for TrajectoriesService.getStats: the per-agent
 * token totals are sums over INTEGER columns, and Postgres returns sum(integer)
 * as bigint. Narrowing that back to int raises "integer out of range" once an
 * agent's lifetime tokens pass 2^31-1, which turns GET /api/trajectories/stats
 * into a permanent 500. Real PGlite database, real service, real schema.
 */
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { TrajectoriesService } from "./TrajectoriesService";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa";
// Three rows of 800M each: the sum (2.4B) exceeds int32 while every row fits.
const PER_ROW = 800_000_000;

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let service: TrajectoriesService;

beforeAll(async () => {
	client = new PGlite();
	db = drizzle(client);
	const runtime = {
		agentId: AGENT_ID,
		adapter: { db },
		getService: () => null,
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
          'traj-${i}', '${AGENT_ID}', 1000, 2000, 1000, 1, 1,
          ${PER_ROW}, ${PER_ROW}, ${PER_ROW}, ${PER_ROW}
        )
      `),
		);
	}
}, 60_000);

afterAll(async () => {
	await client.close();
});

describe("TrajectoriesService.getStats aggregate width", () => {
	it("reports lifetime token totals past 2^31-1 instead of throwing", async () => {
		const stats = await service.getStats();
		expect(stats.totalTrajectories).toBe(3);
		expect(stats.totalPromptTokens).toBe(3 * PER_ROW);
		expect(stats.totalCompletionTokens).toBe(3 * PER_ROW);
		expect(stats.totalCacheReadInputTokens).toBe(3 * PER_ROW);
		expect(stats.totalCacheCreationInputTokens).toBe(3 * PER_ROW);
		expect(3 * PER_ROW).toBeGreaterThan(2 ** 31 - 1);
	});
});
