/**
 * Verifies one runtime model dispatch produces one trajectory LLM record while
 * preserving generic fallback telemetry. Uses real AgentRuntime dispatch with
 * deterministic model handlers and an in-memory trajectory service; no network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { SECRET_SWAP_ENABLED_SETTING } from "../../security/secret-swap";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
	type TrajectoryContext,
} from "../../trajectory-context";
import {
	logActiveTrajectoryLlmCall,
	recordLlmCall,
	type TrajectoryRuntimeLlmCallParams,
} from "../../trajectory-utils";
import { type Character, ModelType, Service } from "../../types";

class CapturingTrajectoryService extends Service {
	static override serviceType = "trajectories";

	override capabilityDescription = "Captures trajectory calls for tests";
	readonly calls: TrajectoryRuntimeLlmCallParams[] = [];
	failWrites = false;

	static async start(
		runtime: AgentRuntime,
	): Promise<CapturingTrajectoryService> {
		return new CapturingTrajectoryService(runtime);
	}

	isEnabled(): boolean {
		return true;
	}

	async startTrajectory(): Promise<string> {
		return "unused-trajectory";
	}

	startStep(): string {
		return "unused-step";
	}

	async endTrajectory(): Promise<void> {}

	async flushWriteQueue(): Promise<void> {}

	logLlmCall(params: TrajectoryRuntimeLlmCallParams): void {
		if (this.failWrites) throw new Error("trajectory write failed");
		this.calls.push(params);
	}

	async stop(): Promise<void> {}
}

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

async function makeRuntime(): Promise<{
	runtime: AgentRuntime;
	trajectory: CapturingTrajectoryService;
}> {
	const runtime = new AgentRuntime({
		character: {
			name: "TrajectoryDedupeAgent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtimes.push(runtime);
	await runtime.registerService(CapturingTrajectoryService);
	await runtime.initialize();
	const trajectory = (await runtime.getServiceLoadPromise(
		"trajectories",
	)) as CapturingTrajectoryService;
	return { runtime, trajectory };
}

function wireDetails(prompt: string) {
	return {
		model: "test-model",
		modelType: ModelType.TEXT_SMALL,
		provider: "test-provider",
		systemPrompt: "system",
		userPrompt: prompt,
		prompt,
		temperature: 0,
		maxTokens: 32,
		purpose: "action",
		actionType: "provider.wire",
	};
}

function withStep<T>(stepId: string, fn: () => Promise<T>): Promise<T> {
	return runWithTrajectoryContext({ trajectoryStepId: stepId }, fn);
}

describe("AgentRuntime.useModel trajectory accounting", () => {
	it("keeps the provider record and suppresses only its generic duplicate", async () => {
		const { runtime, trajectory } = await makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			(rt, params) =>
				recordLlmCall(rt, wireDetails(String(params.prompt)), async () =>
					Promise.resolve("provider-result"),
				),
			"test-provider",
		);

		await expect(
			withStep("step-provider", () =>
				runtime.useModel(ModelType.TEXT_SMALL, { prompt: "provider" }),
			),
		).resolves.toBe("provider-result");
		expect(trajectory.calls).toHaveLength(1);
		expect(trajectory.calls[0]).toMatchObject({
			stepId: "step-provider",
			actionType: "provider.wire",
			response: "provider-result",
		});
	});

	// Regression: the recording scope used to run the model body under a spread
	// clone of the trajectory context. `useModel` mints the turn's swap sessions
	// by assigning onto the context object, so the clone stranded those writes;
	// the action-execution boundary then read `undefined` and *skipped* the
	// restore rather than failing it, shipping raw placeholders onward.
	it("mints the turn's secret swap session on the caller's own context object", async () => {
		const { runtime } = await makeRuntime();
		runtime.setSetting(SECRET_SWAP_ENABLED_SETTING, "true");
		const seenSessions: unknown[] = [];
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				seenSessions.push(getTrajectoryContext()?.secretSwapSession);
				return "swapped";
			},
			"generic-provider",
		);

		const turnContext: TrajectoryContext = { trajectoryStepId: "step-swap" };
		await runWithTrajectoryContext(turnContext, async () => {
			await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "one" });
			// The write must land on the very object the caller passed in, not on
			// a per-call copy.
			expect(turnContext.secretSwapSession).toBeDefined();
			await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "two" });
		});

		expect(turnContext.secretSwapSession).toBeDefined();
		expect(seenSessions).toHaveLength(2);
		// One session for the whole turn, so both calls share a nonce and
		// placeholders minted by the first stay resolvable by the second.
		expect(seenSessions[0]).toBe(turnContext.secretSwapSession);
		expect(seenSessions[1]).toBe(turnContext.secretSwapSession);
	});

	it("retains generic telemetry when the handler has no wire recorder", async () => {
		const { runtime, trajectory } = await makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => "generic-result",
			"generic-provider",
		);

		await withStep("step-generic", () =>
			runtime.useModel(ModelType.TEXT_SMALL, { prompt: "generic" }),
		);
		expect(trajectory.calls).toHaveLength(1);
		expect(trajectory.calls[0]).toMatchObject({
			stepId: "step-generic",
			actionType: "runtime.useModel",
			response: "generic-result",
		});
	});

	it("reports a failed generic trajectory write without losing the model result", async () => {
		const { runtime, trajectory } = await makeRuntime();
		trajectory.failWrites = true;
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => "result-survives-telemetry-failure",
			"generic-provider",
		);

		await expect(
			withStep("step-write-failure", () =>
				runtime.useModel(ModelType.TEXT_SMALL, { prompt: "write failure" }),
			),
		).resolves.toBe("result-survives-telemetry-failure");
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "AgentRuntime.recordUseModelTrajectory",
				message: "trajectory write failed",
			}),
		);
	});

	it("does not suppress fallback for a rejected recording attempt", async () => {
		const { runtime, trajectory } = await makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				expect(
					logActiveTrajectoryLlmCall(null, {
						...wireDetails("rejected"),
						response: "not-recorded",
						latencyMs: 1,
					}),
				).toBe(false);
				return "generic-after-rejection";
			},
			"generic-provider",
		);

		await withStep("step-rejected", () =>
			runtime.useModel(ModelType.TEXT_SMALL, { prompt: "rejected" }),
		);
		expect(trajectory.calls).toHaveLength(1);
		expect(trajectory.calls[0]?.actionType).toBe("runtime.useModel");
	});

	it("records the successful fallback when a wrapped provider fails", async () => {
		const { runtime, trajectory } = await makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			(rt) =>
				recordLlmCall(rt, wireDetails("failed-provider"), async () => {
					const error = new Error("temporarily unavailable") as Error & {
						statusCode: number;
					};
					error.statusCode = 503;
					throw error;
				}),
			"failing-provider",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => "fallback-result",
			"fallback-provider",
			10,
		);

		await expect(
			withStep("step-fallback", () =>
				runtime.useModel(ModelType.TEXT_SMALL, { prompt: "fallback" }),
			),
		).resolves.toBe("fallback-result");
		// The billed-but-failed attempt stays visible as a sanitized failure
		// entry (#17532 Fix 3); the successful fallback records exactly once.
		// The failure record is fire-and-forget, so poll instead of asserting
		// the length synchronously.
		await vi.waitFor(() => expect(trajectory.calls).toHaveLength(2));
		expect(trajectory.calls).toContainEqual(
			expect.objectContaining({
				actionType: "runtime.useModel",
				provider: "failing-provider",
				finishReason: "error",
			}),
		);
		expect(trajectory.calls).toContainEqual(
			expect.objectContaining({
				actionType: "runtime.useModel",
				provider: "fallback-provider",
				response: "fallback-result",
			}),
		);
	});

	it("isolates mixed concurrent calls under one parent trajectory", async () => {
		const { runtime, trajectory } = await makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (rt, params) => {
				const prompt = String(params.prompt);
				if (prompt === "provider") {
					return recordLlmCall(rt, wireDetails(prompt), async () => {
						await Promise.resolve();
						return "provider-result";
					});
				}
				await Promise.resolve();
				return "generic-result";
			},
			"mixed-provider",
		);

		await withStep("step-concurrent", () =>
			Promise.all([
				runtime.useModel(ModelType.TEXT_SMALL, { prompt: "provider" }),
				runtime.useModel(ModelType.TEXT_SMALL, { prompt: "generic" }),
			]),
		);

		expect(trajectory.calls).toHaveLength(2);
		expect(trajectory.calls.map((call) => call.actionType).sort()).toEqual([
			"provider.wire",
			"runtime.useModel",
		]);
	});
});
