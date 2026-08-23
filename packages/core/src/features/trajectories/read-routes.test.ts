/**
 * Unit coverage for the owner-side trajectory viewer read routes
 * (`tryHandleTrajectoryReadRoutes`): path/method gating, the list/detail/stats
 * UI wire shapes (including the timeout→error status collapse and step→phase
 * flattening), search-param forwarding, opt-in room-context resolution, and the
 * service-absent empty-200 fallback. The `ServerResponse` and runtime/service
 * are hand-rolled fakes — deterministic, no HTTP server or database.
 */
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../types";
import { tryHandleTrajectoryReadRoutes } from "./read-routes";

// Minimal ServerResponse capture — records statusCode + parsed JSON body.
function mockRes(): {
	res: ServerResponse;
	get: () => { status: number; body: unknown };
} {
	const state = { status: 0, body: undefined as unknown, ended: false };
	const res = {
		statusCode: 0,
		setHeader() {},
		end(payload?: string) {
			state.status = (this as { statusCode: number }).statusCode;
			state.body = payload ? JSON.parse(payload) : undefined;
			state.ended = true;
		},
	} as unknown as ServerResponse;
	return { res, get: () => ({ status: state.status, body: state.body }) };
}

function runtimeWith(
	service: unknown,
	rooms: Record<string, unknown> = {},
): IAgentRuntime {
	return {
		getService: (type: string) => (type === "trajectories" ? service : null),
		getRoom: async (id: string) => rooms[id] ?? null,
	} as unknown as IAgentRuntime;
}

const url = (p: string) => new URL(`http://localhost${p}`);

describe("tryHandleTrajectoryReadRoutes", () => {
	it("ignores non-trajectory paths and non-GET methods", async () => {
		const { res } = mockRes();
		expect(
			await tryHandleTrajectoryReadRoutes({
				pathname: "/api/health",
				method: "GET",
				url: url("/api/health"),
				runtime: runtimeWith({}),
				res,
			}),
		).toBe(false);
		expect(
			await tryHandleTrajectoryReadRoutes({
				pathname: "/api/trajectories",
				method: "DELETE",
				url: url("/api/trajectories"),
				runtime: runtimeWith({}),
				res,
			}),
		).toBe(false);
	});

	it("lists trajectories from the core service (UI shape, timeout→error)", async () => {
		const service = {
			listTrajectories: async () => ({
				trajectories: [
					{
						id: "t1",
						status: "completed",
						llmCallCount: 3,
						stepCount: 2,
						totalPromptTokens: 120,
						totalCompletionTokens: 18,
						totalCacheReadInputTokens: 64,
						totalCacheCreationInputTokens: 8,
						totalReward: 0.75,
						scenarioId: "scenario-1",
						batchId: "batch-1",
						source: "discord",
						roomId: "room-1",
						entityId: "entity-1",
						metadata: { roomId: "room-1", entityId: "entity-1" },
					},
					{ id: "t2", status: "timeout", llmCallCount: 1 },
				],
				total: 2,
			}),
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?limit=10"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		const { status, body } = get();
		expect(status).toBe(200);
		const b = body as {
			trajectories: Array<Record<string, unknown>>;
			total: number;
		};
		expect(b.total).toBe(2);
		expect(b.trajectories[0]).toMatchObject({
			id: "t1",
			status: "completed",
			llmCallCount: 3,
			stepCount: 2,
			totalPromptTokens: 120,
			totalCompletionTokens: 18,
			totalCacheReadInputTokens: 64,
			totalCacheCreationInputTokens: 8,
			totalReward: 0.75,
			scenarioId: "scenario-1",
			batchId: "batch-1",
		});
		// timeout collapses to the viewer's tri-state "error"
		expect(b.trajectories[1]).toMatchObject({ id: "t2", status: "error" });
	});

	it("normalizes trajectory pagination before forwarding it", async () => {
		let receivedLimit: number | undefined;
		let receivedOffset: number | undefined;
		const service = {
			listTrajectories: async (options: {
				limit?: number;
				offset?: number;
			}) => {
				receivedLimit = options.limit;
				receivedOffset = options.offset;
				return { trajectories: [], total: 0 };
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?limit=1.5&offset=Infinity"),
			runtime: runtimeWith(service),
			res,
		});

		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(receivedLimit).toBe(1);
		expect(receivedOffset).toBe(0);
	});

	it("forwards the search param to the SQL reader so only matches return", async () => {
		const rows = [
			{ id: "match-1", status: "completed", llmCallCount: 1 },
			{ id: "other-1", status: "completed", llmCallCount: 1 },
			{ id: "match-2", status: "completed", llmCallCount: 1 },
		];
		let receivedSearch: string | undefined;
		const service = {
			listTrajectories: async (options: { search?: string }) => {
				receivedSearch = options.search;
				// Emulate the SQL reader: filter + count by the search needle.
				const matched = options.search
					? rows.filter((r) => r.id.includes(options.search as string))
					: rows;
				return { trajectories: matched, total: matched.length };
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?search=match&limit=10"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		// search is threaded through to the service
		expect(receivedSearch).toBe("match");
		const { status, body } = get();
		expect(status).toBe(200);
		const b = body as {
			trajectories: Array<{ id: string }>;
			total: number;
		};
		// only matching rows return; total reflects the filtered count
		expect(b.trajectories.map((t) => t.id)).toEqual(["match-1", "match-2"]);
		expect(b.total).toBe(2);
	});

	it("maps detail steps into phase-classified llmCalls / providerAccesses / toolEvents", async () => {
		const service = {
			getTrajectoryDetail: async (id: string) => ({
				trajectoryId: id,
				agentId: "agent-1",
				startTime: 500,
				endTime: 1000,
				metrics: { finalStatus: "completed" },
				metadata: { source: "discord", roomId: "room-1", entityId: "entity-1" },
				steps: [
					{
						stepId: "s0",
						semanticStages: [
							{
								schemaVersion: 1,
								stageId: "search-1",
								kind: "toolSearch",
								startedAt: 501,
								endedAt: 503,
								latencyMs: 2,
								payload: {
									toolSearch: {
										query: { candidateActions: ["REPLY"] },
										results: [{ name: "REPLY", rank: 1, score: 1 }],
									},
								},
							},
						],
						llmCalls: [
							{
								callId: "c0",
								timestamp: 520,
								model: "m",
								modelVersion: "v1",
								response: "RESPOND",
								stepType: "should_respond",
								latencyMs: 17,
								promptTokens: 40,
								completionTokens: 4,
							},
							{
								callId: "c1",
								model: "m",
								userPrompt: "open notes",
								response: "plan",
								stepType: "reasoning",
								latencyMs: 23,
							},
						],
						providerAccesses: [
							{ providerId: "p0", providerName: "facts", purpose: "ctx" },
						],
						action: {
							attemptId: "a0",
							actionType: "REPLY",
							actionName: "REPLY",
							success: true,
						},
					},
				],
			}),
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/abc",
			method: "GET",
			url: url("/api/trajectories/abc"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		const { status, body } = get();
		expect(status).toBe(200);
		const b = body as {
			trajectory: {
				id: string;
				status: string;
				source: string;
				roomId: string;
				entityId: string;
				metadata: Record<string, unknown>;
				llmCallCount: number;
			};
			llmCalls: Array<{
				stepType: string;
				stepId: string;
				timestamp?: number;
				latencyMs?: number;
				promptTokens?: number;
				completionTokens?: number;
				userPrompt?: string;
			}>;
			providerAccesses: Array<{
				stepId: string;
				providerName: string;
			}>;
			toolEvents: Array<{
				actionName: string;
				success: boolean;
			}>;
			semanticStages: Array<{
				stageId: string;
				payload: Record<string, unknown>;
			}>;
		};
		expect(b.trajectory).toMatchObject({
			id: "abc",
			status: "completed",
			source: "discord",
			roomId: "room-1",
			entityId: "entity-1",
			metadata: { source: "discord", roomId: "room-1", entityId: "entity-1" },
			llmCallCount: 2,
		});
		expect(b.llmCalls.map((c) => c.stepType)).toEqual([
			"should_respond",
			"reasoning",
		]);
		expect(b.llmCalls).toMatchObject([
			{
				stepId: "s0",
				timestamp: 520,
				latencyMs: 17,
				promptTokens: 40,
				completionTokens: 4,
			},
			{ stepId: "s0", userPrompt: "open notes", latencyMs: 23 },
		]);
		expect(b.providerAccesses).toHaveLength(1);
		expect(b.providerAccesses[0]).toMatchObject({
			stepId: "s0",
			providerName: "facts",
		});
		expect(b.toolEvents[0]).toMatchObject({
			actionName: "REPLY",
			success: true,
			type: "tool_result",
		});
		expect(b.semanticStages).toMatchObject([
			{
				stageId: "search-1",
				payload: {
					toolSearch: {
						query: { candidateActions: ["REPLY"] },
						results: [{ name: "REPLY", rank: 1 }],
					},
				},
			},
		]);
	});

	it("returns LLM-only detail without fabricating a tool event", async () => {
		const service = {
			getTrajectoryDetail: async (id: string) => ({
				trajectoryId: id,
				agentId: "agent-1",
				startTime: 500,
				endTime: 1000,
				metrics: { episodeLength: 1, finalStatus: "completed" },
				metadata: { source: "chat" },
				steps: [
					{
						stepId: "s0",
						llmCalls: [
							{
								callId: "c0",
								model: "m",
								response: "hello",
								stepType: "reasoning",
								provider: "openai",
							},
						],
						providerAccesses: [],
						// Agent bridge action-optional step — no action field.
					},
				],
			}),
		};
		const { res, get } = mockRes();

		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/llm-only",
			method: "GET",
			url: url("/api/trajectories/llm-only"),
			runtime: runtimeWith(service),
			res,
		});

		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(get().body).toMatchObject({
			trajectory: { id: "llm-only", status: "completed", llmCallCount: 1 },
			llmCalls: [{ id: "c0", response: "hello" }],
			toolEvents: [],
		});
	});

	it("resolves room context only when requested", async () => {
		const service = {
			listTrajectories: async () => ({
				trajectories: [
					{
						id: "t1",
						status: "completed",
						llmCallCount: 1,
						metadata: { roomId: "room-1" },
					},
				],
				total: 1,
			}),
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories?resolve=1"),
			runtime: runtimeWith(service, {
				"room-1": {
					id: "room-1",
					name: "ruby-trivia",
					type: "GROUP",
					worldId: "world-1",
					serverId: "guild-1",
				},
			}),
			res,
		});
		expect(handled).toBe(true);
		const rows = (
			get().body as { trajectories: Array<Record<string, unknown>> }
		).trajectories;
		expect(rows[0].roomContext).toEqual({
			id: "room-1",
			name: "ruby-trivia",
			type: "GROUP",
			worldId: "world-1",
			serverId: "guild-1",
		});
	});

	it("404s an unknown detail id", async () => {
		const service = { getTrajectoryDetail: async () => null };
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/missing",
			method: "GET",
			url: url("/api/trajectories/missing"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(404);
	});

	it("returns an unavailable error when the service is absent", async () => {
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories",
			method: "GET",
			url: url("/api/trajectories"),
			runtime: runtimeWith(null),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(503);
		expect(get().body).toEqual({ error: "Trajectory service unavailable" });
	});

	it("does not treat /stats or /config as a detail id", async () => {
		const service = {
			getStats: async () => ({ totalTrajectories: 5 }),
			getTrajectoryDetail: async () => {
				throw new Error("should not be called for /stats");
			},
		};
		const { res, get } = mockRes();
		const handled = await tryHandleTrajectoryReadRoutes({
			pathname: "/api/trajectories/stats",
			method: "GET",
			url: url("/api/trajectories/stats"),
			runtime: runtimeWith(service),
			res,
		});
		expect(handled).toBe(true);
		expect(get().status).toBe(200);
		expect(get().body).toMatchObject({ totalTrajectories: 5 });
	});
});
