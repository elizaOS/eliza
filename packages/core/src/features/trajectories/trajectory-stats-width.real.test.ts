/**
 * Real-PGlite regression for lifetime trajectory stats past 2^31-1 tokens.
 * getStats sums INTEGER token columns with no time window; narrowing the
 * aggregates back to int throws `integer out of range` and bricks the stats
 * endpoint permanently once cumulative tokens cross 2,147,483,647 (#30291).
 */

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { TrajectoriesService } from "./TrajectoriesService";

const AGENT_ID = "00000000-0000-4000-8000-000000000091";
// Three rows of 800M summable units each: every lifetime total lands at
// 2.4B, past the int32 ceiling the old ::int casts could not represent.
const ROW_WIDTH = 800_000_000;
const EXPECTED_TOTAL = 3 * ROW_WIDTH;

let db: ReturnType<typeof drizzle>;
let client: PGlite;
let service: TrajectoriesService;

async function seedWideRow(index: number): Promise<void> {
	await db.execute(
		sql.raw(`INSERT INTO trajectories
    (id, agent_id, source, status, start_time,
     step_count, llm_call_count,
     total_prompt_tokens, total_completion_tokens,
     total_cache_read_input_tokens, total_cache_creation_input_tokens)
    VALUES
    ('10000000-0000-4000-8000-00000000009${index}', '${AGENT_ID}', 'chat', 'completed', 1700000000000,
     ${ROW_WIDTH}, ${ROW_WIDTH},
     ${ROW_WIDTH}, ${ROW_WIDTH}, ${ROW_WIDTH}, ${ROW_WIDTH})`),
	);
}

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
	for (const index of [1, 2, 3]) {
		await seedWideRow(index);
	}
}, 60_000);

afterAll(async () => {
	await client?.close?.();
});

describe("trajectory lifetime stats past int32 (real PGlite)", () => {
	it("reports lifetime token totals past 2^31-1 instead of throwing", async () => {
		const stats = await service.getStats();
		expect(stats.totalTrajectories).toBe(3);
		expect(stats.totalPromptTokens).toBe(EXPECTED_TOTAL);
		expect(stats.totalCompletionTokens).toBe(EXPECTED_TOTAL);
		expect(stats.totalCacheReadInputTokens).toBe(EXPECTED_TOTAL);
		expect(stats.totalCacheCreationInputTokens).toBe(EXPECTED_TOTAL);
		expect(stats.totalSteps).toBe(EXPECTED_TOTAL);
		expect(stats.totalLlmCalls).toBe(EXPECTED_TOTAL);
	});
});
