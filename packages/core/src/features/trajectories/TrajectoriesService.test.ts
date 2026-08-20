/**
 * Unit coverage for `TrajectoriesService`: it disables capture when the runtime
 * adapter exposes no SQL executor, bounds and JSON-sanitizes LLM-call payloads
 * (truncation, circular refs, functions) before persisting, keeps queued step
 * writes parseable, skips internal embedding calls, and surfaces persisted
 * metadata on list rows. The runtime and its SQL executor are stubbed
 * (`executeRawSql` overridden against an in-memory row) — deterministic, no real
 * database.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { TrajectoriesService } from "./TrajectoriesService";

function createRuntimeWithoutSql(): IAgentRuntime {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		adapter: { db: {} },
		getService: () => null,
		getServicesByType: () => [],
		reportError: () => {},
	} as unknown as IAgentRuntime;
}

function makeTrajectoryRow(trajectoryId: string, stepId: string) {
	return {
		id: trajectoryId,
		agent_id: "00000000-0000-4000-8000-000000000001",
		status: "active",
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
				reward: 0,
				done: false,
			},
		]),
		reward_components_json: JSON.stringify({ environmentReward: 0 }),
		metrics_json: JSON.stringify({ episodeLength: 1, finalStatus: "active" }),
		metadata_json: JSON.stringify({}),
		total_reward: 0,
	};
}

function makeEmptyTrajectoryRow(trajectoryId: string) {
	return {
		id: trajectoryId,
		agent_id: "00000000-0000-4000-8000-000000000001",
		status: "active",
		start_time: 1,
		end_time: null,
		duration_ms: null,
		steps_json: JSON.stringify([]),
		reward_components_json: JSON.stringify({ environmentReward: 0 }),
		metrics_json: JSON.stringify({ episodeLength: 0, finalStatus: "active" }),
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
		const runtimeSecret = "SYNTH-CORE-DB-RUNTIME-SECRET-1111";
		const flagCanary = "SYNTH-CORE-DB-FLAG-CANARY-2222";
		const uriCanary = "SYNTH-CORE-DB-URI-CANARY-3333";
		const row = makeTrajectoryRow(trajectoryId, stepId);
		const service = new TrajectoriesService({
			...createRuntimeWithoutSql(),
			redactSecrets: (text: string) =>
				text.split(runtimeSecret).join("[REDACTED:DB_CANARY]"),
		} as IAgentRuntime);
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
			runId: "run-identity-1",
			roomId: "room-identity-1",
			messageId: "message-identity-1",
			executionTraceId: "trace-identity-1",
			systemPrompt: "system",
			userPrompt: "user",
			messages: [
				{
					role: "assistant",
					content: `--token=${flagCanary} ${runtimeSecret} ${"m".repeat(120_000)}`,
					circular,
				},
			],
			tools: { circular },
			toolCalls: [
				{
					id: "call-1",
					name: "CANARY_TOOL",
					args: {
						target: `https://user:${uriCanary}@synthetic.invalid/`,
					},
				},
			],
			providerMetadata: circular,
			response: `ok ${runtimeSecret}`,
			temperature: 0,
			maxTokens: 1024,
			purpose: "action",
			actionType: "runtime.useModel",
			latencyMs: 1,
			providerOrder: ["CHARACTER"],
			providerAttributions: [
				{
					providerName: "CHARACTER",
					sha256:
						"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					tokenCount: 8,
					position: 0,
					spanStart: 5,
					spanEnd: 19,
				},
			],
		});
		await service.flushWriteQueue(trajectoryId);

		expect(updates).toHaveLength(1);
		expect(updates[0].length).toBeLessThan(350_000);

		const persisted = JSON.parse(row.steps_json);
		const persistedJson = JSON.stringify(persisted);
		expect(persistedJson).not.toContain(runtimeSecret);
		expect(persistedJson).not.toContain(flagCanary);
		expect(persistedJson).not.toContain(uriCanary);
		const call = persisted[0].llmCalls[0];
		expect(call.messages[0].content).toMatch(/\.{3}\[truncated\]$/);
		expect(call.tools.circular.self).toBe("[REDACTED]");
		expect(call.tools.circular.fn).toBe("[Function toolHandler]");
		expect(call.providerMetadata.self).toBe("[REDACTED]");
		expect(call.providerOrder).toEqual(["CHARACTER"]);
		expect(call.runId).toBe("run-identity-1");
		expect(call.roomId).toBe("room-identity-1");
		expect(call.messageId).toBe("message-identity-1");
		expect(call.executionTraceId).toBe("trace-identity-1");
		expect(call.providerAttributions[0]).toMatchObject({
			providerName: "CHARACTER",
			tokenCount: 8,
			position: 0,
			tokenCountEstimated: true,
		});
		expect(call.providerAttributions[0].spanStart).toBeUndefined();
		expect(call.providerAttributions[0].spanEnd).toBeUndefined();
	});

	it("projects the complete action settlement including interceptor reasoning", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000012";
		const stepId = "00000000-0000-4000-8000-000000000013";
		const runtimeSecret = "SYNTH-SETTLEMENT-RUNTIME-SECRET-4444";
		const flagCanary = "SYNTH-SETTLEMENT-FLAG-CANARY-5555";
		const row = makeTrajectoryRow(trajectoryId, stepId);
		const runtime = {
			...createRuntimeWithoutSql(),
			redactSecrets: (text: string) =>
				text.split(runtimeSecret).join("[REDACTED:SETTLEMENT]"),
		} as IAgentRuntime;
		const service = new TrajectoriesService(runtime);
		const serviceInternals = service as unknown as {
			stepToTrajectory: Map<string, string>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
			executeRawSqlTransaction: <T>(
				work: (
					execute: (sqlText: string) => Promise<{
						rows: Array<Record<string, unknown>>;
						columns: string[];
					}>,
				) => Promise<T>,
			) => Promise<T>;
		};

		serviceInternals.stepToTrajectory.set(stepId, trajectoryId);
		serviceInternals.executeRawSql = async (sqlText: string) => {
			if (sqlText.includes("SELECT * FROM trajectories")) {
				return { rows: [row], columns: Object.keys(row) };
			}
			if (sqlText.includes("UPDATE trajectories SET")) {
				const stepsJson = extractSqlStringAssignment(sqlText, "steps_json");
				if (stepsJson) row.steps_json = stepsJson;
			}
			return { rows: [], columns: [] };
		};
		serviceInternals.executeRawSqlTransaction = (work) =>
			work(serviceInternals.executeRawSql);

		service.completeStep(trajectoryId, stepId, {
			actionType: "CANARY_TOOL",
			actionName: "CANARY_TOOL",
			parameters: { command: `run --token=${flagCanary}`, retries: 2 },
			llmCallId: "llm-call-identity-1",
			success: false,
			result: { error: `rejected ${runtimeSecret}` },
			error: `rejected ${runtimeSecret}`,
			reasoning: `Action CANARY_TOOL failed with --token=${flagCanary}`,
		});
		await service.flushWriteQueue(trajectoryId);

		const persisted = JSON.parse(row.steps_json)[0].action;
		const serialized = JSON.stringify(persisted);
		expect(serialized).not.toContain(runtimeSecret);
		expect(serialized).not.toContain(flagCanary);
		expect(persisted.actionName).toBe("CANARY_TOOL");
		expect(persisted.llmCallId).toBe("llm-call-identity-1");
		expect(persisted.parameters.retries).toBe(2);
		expect(persisted.reasoning).toContain("Action CANARY_TOOL failed");
	});

	it("keeps empty step objects parseable across queued step writes", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000030";
		const row = makeEmptyTrajectoryRow(trajectoryId);
		const service = new TrajectoriesService(createRuntimeWithoutSql());
		const serviceInternals = service as unknown as {
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
			executeRawSqlTransaction: <T>(
				work: (
					execute: (sqlText: string) => Promise<{
						rows: Array<Record<string, unknown>>;
						columns: string[];
					}>,
				) => Promise<T>,
			) => Promise<T>;
		};

		serviceInternals.executeRawSql = async (sqlText: string) => {
			if (sqlText.includes("SELECT * FROM trajectories")) {
				return { rows: [row], columns: Object.keys(row) };
			}
			if (sqlText.includes("UPDATE trajectories SET")) {
				const stepsJson = extractSqlStringAssignment(sqlText, "steps_json");
				if (stepsJson) {
					row.steps_json = stepsJson;
				}
			}
			return { rows: [], columns: [] };
		};
		serviceInternals.executeRawSqlTransaction = (work) =>
			work(serviceInternals.executeRawSql);

		service.startStep(trajectoryId, {
			timestamp: 1,
			agentBalance: 0,
			agentPoints: 0,
			agentPnL: 0,
			openPositions: 0,
		});
		await service.flushWriteQueue(trajectoryId);
		service.startStep(trajectoryId, {
			timestamp: 2,
			agentBalance: 0,
			agentPoints: 0,
			agentPnL: 0,
			openPositions: 0,
		});
		await service.flushWriteQueue(trajectoryId);

		const persisted = JSON.parse(row.steps_json);
		expect(persisted).toHaveLength(2);
		expect(persisted[0].observation).toEqual({});
		expect(persisted[0].action).toBeUndefined();
		expect(persisted[1].stepNumber).toBe(1);
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

	it("includes persisted metadata on trajectory list rows", async () => {
		const service = new TrajectoriesService({
			agentId: "00000000-0000-4000-8000-000000000001",
			adapter: { db: { execute: async () => ({ rows: [] }) } },
			getService: () => null,
			getServicesByType: () => [],
			reportError: () => {},
		} as unknown as IAgentRuntime);
		const serviceInternals = service as unknown as {
			ensureStorageReady: () => Promise<void>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		serviceInternals.ensureStorageReady = async () => {};
		const seenSql: string[] = [];
		serviceInternals.executeRawSql = async (sqlText: string) => {
			seenSql.push(sqlText);
			if (sqlText.includes("count(*)")) {
				return { rows: [{ total: 1 }], columns: ["total"] };
			}
			return {
				rows: [
					{
						id: "00000000-0000-4000-8000-000000000030",
						agent_id: "00000000-0000-4000-8000-000000000001",
						source: "discord",
						status: "completed",
						start_time: 1000,
						end_time: 1500,
						duration_ms: 500,
						steps_json: "[]",
						reward_components_json: JSON.stringify({
							environmentReward: 0,
						}),
						metrics_json: JSON.stringify({
							episodeLength: 0,
							finalStatus: "completed",
						}),
						step_count: 1,
						llm_call_count: 2,
						total_prompt_tokens: 10,
						total_completion_tokens: 20,
						total_cache_read_input_tokens: 0,
						total_cache_creation_input_tokens: 0,
						total_reward: 0,
						scenario_id: null,
						batch_id: null,
						metadata_json: JSON.stringify({
							roomId: "room-1",
							entityId: "entity-1",
							source: "discord",
						}),
						created_at: "1970-01-01T00:00:01.000Z",
						updated_at: "1970-01-01T00:00:01.500Z",
					},
				],
				columns: [],
			};
		};

		const result = await service.listTrajectories({ limit: 1 });

		expect(seenSql.some((sql) => sql.includes("metadata_json"))).toBe(true);
		expect(result.trajectories[0]).toMatchObject({
			source: "discord",
			roomId: "room-1",
			entityId: "entity-1",
			metadata: { roomId: "room-1", entityId: "entity-1", source: "discord" },
		});
	});

	it("surfaces unavailable query storage instead of returning a healthy empty list", async () => {
		const service = new TrajectoriesService(createRuntimeWithoutSql());

		await expect(service.listTrajectories()).rejects.toMatchObject({
			code: "TRAJECTORY_STORAGE_UNAVAILABLE",
		});
	});

	it("rejects malformed persisted list rows instead of fabricating required fields", async () => {
		const service = new TrajectoriesService({
			agentId: "00000000-0000-4000-8000-000000000001",
			adapter: { db: { execute: async () => ({ rows: [] }) } },
			getService: () => null,
			getServicesByType: () => [],
			reportError: () => {},
		} as unknown as IAgentRuntime);
		const serviceInternals = service as unknown as {
			ensureStorageReady: () => Promise<void>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		serviceInternals.ensureStorageReady = async () => {};
		serviceInternals.executeRawSql = async (sqlText: string) =>
			sqlText.includes("count(*)")
				? { rows: [{ total: 1 }], columns: ["total"] }
				: {
						rows: [
							{
								id: "00000000-0000-4000-8000-000000000030",
								agent_id: "00000000-0000-4000-8000-000000000001",
								source: "chat",
								status: "completed",
								start_time: 1000,
								end_time: 1500,
								duration_ms: 500,
								steps_json: "[]",
								reward_components_json: JSON.stringify({
									environmentReward: 0,
								}),
								metrics_json: JSON.stringify({
									episodeLength: 0,
									finalStatus: "completed",
								}),
								step_count: 1,
								llm_call_count: null,
								total_prompt_tokens: 10,
								total_completion_tokens: 20,
								total_cache_read_input_tokens: 0,
								total_cache_creation_input_tokens: 0,
								total_reward: 0,
								metadata_json: "{}",
								created_at: "1970-01-01T00:00:01.000Z",
								updated_at: "1970-01-01T00:00:01.500Z",
							},
						],
						columns: [],
					};

		await expect(service.listTrajectories()).rejects.toMatchObject({
			code: "TRAJECTORY_ROW_INVALID",
			context: { field: "llm_call_count" },
		});
	});

	it("keeps the step envelope readable when payload exhausts the sanitization budget", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000040";
		const stepId = "00000000-0000-4000-8000-000000000041";
		const row = makeTrajectoryRow(trajectoryId, stepId);
		const service = new TrajectoriesService(createRuntimeWithoutSql());
		const serviceInternals = service as unknown as {
			stepToTrajectory: Map<string, string>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		serviceInternals.stepToTrajectory.set(stepId, trajectoryId);
		serviceInternals.executeRawSql = async (sqlText: string) => {
			if (sqlText.includes("SELECT * FROM trajectories")) {
				return { rows: [row], columns: Object.keys(row) };
			}
			if (sqlText.includes("UPDATE trajectories SET")) {
				const stepsJson = extractSqlStringAssignment(sqlText, "steps_json");
				if (stepsJson) {
					row.steps_json = stepsJson;
				}
			}
			return { rows: [], columns: [] };
		};

		// Two planner-style calls whose tool schemas together cross the shared
		// node budget at write time — the live incident shape (2026-08-10: the
		// second call's tools broke out of the step object mid-walk and the
		// dropped trailing keys made every subsequent read of the row throw).
		const bigTools = Array.from({ length: 200 }, (_, i) => ({
			name: `tool${i}`,
			description: "d",
			parameters: {
				a: 1,
				b: 2,
				c: 3,
				d: 4,
				e: 5,
				f: 6,
				g: 7,
				h: 8,
				i: 9,
				j: 10,
			},
		}));
		const baseCall = {
			stepId,
			model: "zai-glm-4.7",
			modelType: "ACTION_PLANNER",
			provider: "cerebras",
			systemPrompt: "system",
			userPrompt: "user",
			response: "ok",
			temperature: 0,
			maxTokens: 1024,
			purpose: "action",
			actionType: "runtime.useModel",
			latencyMs: 1,
		};
		service.logLlmCall({ ...baseCall, tools: bigTools });
		await service.flushWriteQueue(trajectoryId);
		service.logLlmCall({ ...baseCall, tools: bigTools });
		await service.flushWriteQueue(trajectoryId);

		const afterOverflow = JSON.parse(row.steps_json);
		expect(afterOverflow[0].reward).toBe(0);
		expect(afterOverflow[0].done).toBe(false);
		expect(Array.isArray(afterOverflow[0].providerAccesses)).toBe(true);
		expect(afterOverflow[0].metadata.truncatedLlmCalls).toBe(1);

		// The row must still accept captures — pre-fix this write was lost to
		// TRAJECTORY_ROW_INVALID and the trajectory could never terminalize.
		service.logLlmCall(baseCall);
		await service.flushWriteQueue(trajectoryId);

		const persisted = JSON.parse(row.steps_json);
		expect(persisted[0].llmCalls).toHaveLength(2);
		expect(persisted[0].reward).toBe(0);
		expect(persisted[0].done).toBe(false);
		expect(persisted[0].metadata.truncatedLlmCalls).toBe(1);
	});

	it("reads legacy rows whose steps lost trailing keys to budget truncation", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000050";
		const stepId = "00000000-0000-4000-8000-000000000051";
		const row = makeTrajectoryRow(trajectoryId, stepId);
		// The exact persisted shape recovered from the incident database: the
		// envelope stops after environmentState — no providerAccesses, reward,
		// or done — with one otherwise-valid llmCall.
		row.steps_json = JSON.stringify([
			{
				stepId,
				stepNumber: 0,
				timestamp: 1,
				environmentState: { timestamp: 1 },
				observation: {},
				llmCalls: [
					{
						callId: "00000000-0000-4000-8000-000000000052",
						timestamp: 1,
						model: "gemma-4-31b",
						systemPrompt: "s",
						userPrompt: "u",
						response: "r",
						purpose: "action",
					},
				],
			},
		]);
		const service = new TrajectoriesService(createRuntimeWithoutSql());
		const serviceInternals = service as unknown as {
			stepToTrajectory: Map<string, string>;
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		serviceInternals.stepToTrajectory.set(stepId, trajectoryId);
		serviceInternals.executeRawSql = async (sqlText: string) => {
			if (sqlText.includes("SELECT * FROM trajectories")) {
				return { rows: [row], columns: Object.keys(row) };
			}
			if (sqlText.includes("UPDATE trajectories SET")) {
				const stepsJson = extractSqlStringAssignment(sqlText, "steps_json");
				if (stepsJson) {
					row.steps_json = stepsJson;
				}
			}
			return { rows: [], columns: [] };
		};

		service.logLlmCall({
			stepId,
			model: "gemma-4-31b",
			modelType: "RESPONSE_HANDLER",
			provider: "cerebras",
			systemPrompt: "system",
			userPrompt: "user",
			response: "ok",
			temperature: 0,
			maxTokens: 64,
			purpose: "action",
			actionType: "runtime.useModel",
			latencyMs: 1,
		});
		await service.flushWriteQueue(trajectoryId);

		const persisted = JSON.parse(row.steps_json);
		expect(persisted[0].llmCalls).toHaveLength(2);
		expect(persisted[0].reward).toBe(0);
		expect(persisted[0].done).toBe(false);
		expect(persisted[0].providerAccesses).toEqual([]);
	});

	it("persists recorder decision stages onto the step and stays idempotent per stageId", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000060";
		const stepId = "00000000-0000-4000-8000-000000000061";
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
				if (stepsJson) row.steps_json = stepsJson;
			}
			return { rows: [], columns: [] };
		};

		const stage = {
			stageId: "stage-tool-search-60",
			kind: "toolSearch" as const,
			iteration: 1,
			startedAt: 100,
			endedAt: 112,
			latencyMs: 12,
			toolSearch: {
				query: { candidateActions: ["OWNER_ROUTINES", "VIEWS"] },
				results: [
					{ name: "OWNER_ROUTINES", score: 0.4, rank: 1 },
					{ name: "VIEWS", score: 0.2, rank: 2 },
				],
				selectedActions: ["OWNER_ROUTINES"],
			},
		};

		service.logSemanticStage({ stepId, stage });
		service.logSemanticStage({ stepId, stage });
		await service.flushWriteQueue(trajectoryId);

		expect(updates).toHaveLength(1);
		const persisted = JSON.parse(row.steps_json);
		expect(persisted[0].semanticStages).toHaveLength(1);
		expect(persisted[0].semanticStages[0]).toMatchObject({
			schemaVersion: 1,
			stageId: "stage-tool-search-60",
			kind: "toolSearch",
			latencyMs: 12,
			payload: {
				toolSearch: { selectedActions: ["OWNER_ROUTINES"] },
			},
		});
		// The persisted row must round-trip through the strict step reader.
		const readBack = await (
			service as unknown as {
				getTrajectoryById: (
					id: string,
				) => Promise<{ steps: Array<Record<string, unknown>> } | null>;
			}
		).getTrajectoryById(trajectoryId);
		expect(readBack?.steps[0].semanticStages).toHaveLength(1);
	});

	it("reports an invalid decision stage under J7 instead of persisting garbage", async () => {
		const trajectoryId = "00000000-0000-4000-8000-000000000062";
		const stepId = "00000000-0000-4000-8000-000000000063";
		const row = makeTrajectoryRow(trajectoryId, stepId);
		const reported: string[] = [];
		const runtime = {
			...createRuntimeWithoutSql(),
			reportError: (scope: string) => {
				reported.push(scope);
			},
		} as IAgentRuntime;
		const service = new TrajectoriesService(runtime);
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
			if (sqlText.includes("UPDATE trajectories SET")) updates.push(sqlText);
			return { rows: [], columns: [] };
		};

		service.logSemanticStage({
			stepId,
			stage: {
				stageId: "bad-stage",
				kind: "toolSearch",
				startedAt: 10,
				endedAt: 5,
				latencyMs: -5,
			},
		});
		await service.flushWriteQueue(trajectoryId);

		expect(updates).toHaveLength(0);
		expect(reported).toContain("TrajectoriesService.detachedWrite");
	});
});
