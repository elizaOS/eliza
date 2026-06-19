import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { TrajectoriesService } from "./TrajectoriesService";

function createRuntimeWithoutSql(): IAgentRuntime {
	return {
		adapter: { db: {} },
		getService: () => null,
		getServicesByType: () => [],
	} as unknown as IAgentRuntime;
}

function makeTrajectoryRow(trajectoryId: string, stepId: string) {
	return {
		id: trajectoryId,
		agent_id: "00000000-0000-4000-8000-000000000001",
		start_time: 1,
		end_time: null,
		duration_ms: null,
		steps_json: JSON.stringify([
			{
				stepId,
				stepNumber: 0,
				timestamp: 1,
				environmentState: {
					timestamp: 1,
					agentBalance: 0,
					agentPoints: 0,
					agentPnL: 0,
					openPositions: 0,
				},
				observation: {},
				llmCalls: [],
				providerAccesses: [],
				action: {
					attemptId: "pending",
					timestamp: 1,
					actionType: "pending",
					actionName: "pending",
					parameters: {},
					success: false,
				},
				reward: 0,
				done: false,
			},
		]),
		reward_components_json: JSON.stringify({ environmentReward: 0 }),
		metrics_json: JSON.stringify({}),
		metadata_json: JSON.stringify({}),
		total_reward: 0,
	};
}

function extractSqlStringAssignment(
	sqlText: string,
	column: string,
): string | null {
	const match = new RegExp(`${column}\\s*=\\s*'((?:''|[^'])*)'`).exec(sqlText);
	return match ? match[1].replace(/''/g, "'") : null;
}

describe("TrajectoriesService", () => {
	it("disables SQL-backed capture when the runtime adapter has no SQL executor", async () => {
		const service = await TrajectoriesService.start(createRuntimeWithoutSql());

		expect((service as TrajectoriesService).isEnabled()).toBe(false);

		await service.stop();
	});

	it("persists LLM calls with bounded JSON-safe payloads", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000010";
		const stepId = "00000000-0000-4000-8000-000000000011";
		const row = makeTrajectoryRow(trajectoryId, stepId);
		const service = new TrajectoriesService(createRuntimeWithoutSql());
		const serviceInternals = service as unknown as {
			stepToTrajectory: Map<string, string>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		const updates: string[] = [];

		serviceInternals.stepToTrajectory.set(stepId, trajectoryId);
		serviceInternals.executeRawSql = async (sqlText: string) => {
			if (sqlText.includes("SELECT * FROM trajectories")) {
				return { rows: [row], columns: Object.keys(row) };
			}
			if (sqlText.includes("UPDATE trajectories SET")) {
				updates.push(sqlText);
				const stepsJson = extractSqlStringAssignment(sqlText, "steps_json");
				if (stepsJson) {
					row.steps_json = stepsJson;
				}
			}
			return { rows: [], columns: [] };
		};

		const circular: Record<string, unknown> = {
			long: "x".repeat(120_000),
			fn: function toolHandler() {
				return "ok";
			},
		};
		circular.self = circular;

		service.logLlmCall({
			stepId,
			model: "gpt-oss-120b",
			modelType: "RESPONSE_HANDLER",
			provider: "cerebras",
			systemPrompt: "system",
			userPrompt: "user",
			messages: [{ role: "user", content: "m".repeat(120_000), circular }],
			tools: { circular },
			providerMetadata: circular,
			response: "ok",
			temperature: 0,
			maxTokens: 1024,
			purpose: "action",
			actionType: "runtime.useModel",
			latencyMs: 1,
		});
		await service.flushWriteQueue(trajectoryId);

		expect(updates).toHaveLength(1);
		expect(updates[0].length).toBeLessThan(350_000);

		const persisted = JSON.parse(row.steps_json);
		const call = persisted[0].llmCalls[0];
		expect(call.messages[0].content).toMatch(/\.{3}\[truncated\]$/);
		expect(call.tools.circular.self).toBe("[Circular]");
		expect(call.tools.circular.fn).toBe("[Function toolHandler]");
		expect(call.providerMetadata.self).toBe("[Circular]");
	});

	it("does not persist internal embedding calls as trajectory LLM calls", () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000020";
		const stepId = "00000000-0000-4000-8000-000000000021";
		const service = new TrajectoriesService(createRuntimeWithoutSql());
		const serviceInternals = service as unknown as {
			stepToTrajectory: Map<string, string>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		const updates: string[] = [];

		serviceInternals.stepToTrajectory.set(stepId, trajectoryId);
		serviceInternals.executeRawSql = async (sqlText: string) => {
			if (sqlText.includes("UPDATE trajectories SET")) {
				updates.push(sqlText);
			}
			return { rows: [], columns: [] };
		};

		service.logLlmCall({
			stepId,
			model: "text-embedding-3-small",
			modelType: "TEXT_EMBEDDING",
			provider: "openai",
			systemPrompt: "",
			userPrompt: "embed this",
			response: JSON.stringify([0.1, 0.2, 0.3]),
			temperature: 0,
			maxTokens: 0,
			purpose: "embedding",
			actionType: "runtime.useModel",
			latencyMs: 1,
		});

		expect(updates).toHaveLength(0);
	});
});
