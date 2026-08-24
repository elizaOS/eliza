/**
 * Unit coverage for the manual trajectory instrumentation helpers in
 * `integration.ts`: `startAutonomousTick` forwards the tick context and opens a
 * timestamped step, `endAutonomousTick` flushes queued writes before ending and
 * defaults the status to "completed", `loggedLLMCall` records a payload only
 * under an active step (purpose defaulting to "action" and callee-reported
 * latency preferred over wall clock), `logProviderAccess` delegates verbatim,
 * and `withTrajectoryLogging` completes the step only on success. The
 * collaborating TrajectoriesService is an ordered recording double —
 * deterministic, no runtime or database; every asserted field is produced by
 * this module, not by the double.
 */
import { describe, expect, it } from "vitest";
import {
	endAutonomousTick,
	loggedLLMCall,
	logProviderAccess,
	startAutonomousTick,
	withTrajectoryLogging,
} from "./integration";
import type { TrajectoriesService } from "./TrajectoriesService";

type RecordedCall = { method: string; args: unknown[] };

function createRecordingService(
	config: { trajectoryId?: string; currentStepId?: string | null } = {},
): { service: TrajectoriesService; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args });
	};
	const service = {
		startTrajectory: async (...args: unknown[]) => {
			record("startTrajectory", args);
			return config.trajectoryId ?? "traj-1";
		},
		startStep: (...args: unknown[]) => record("startStep", args),
		flushWriteQueue: async (...args: unknown[]) =>
			record("flushWriteQueue", args),
		endTrajectory: async (...args: unknown[]) => record("endTrajectory", args),
		getCurrentStepId: (...args: unknown[]) => {
			record("getCurrentStepId", args);
			return config.currentStepId ?? null;
		},
		logLLMCall: (...args: unknown[]) => record("logLLMCall", args),
		logProviderAccessByTrajectoryId: (...args: unknown[]) =>
			record("logProviderAccessByTrajectoryId", args),
		completeStep: (...args: unknown[]) => record("completeStep", args),
	};
	return { service: service as unknown as TrajectoriesService, calls };
}

type LoggedLLMPayload = {
	model?: string;
	systemPrompt?: string;
	response?: string;
	purpose?: string;
	actionType?: string;
	promptTokens?: number;
	completionTokens?: number;
	latencyMs?: number;
};

type CompleteStepPayload = {
	actionType: string;
	actionName: string;
	parameters: { args: unknown[] };
	success: boolean;
	result: { result: unknown };
};

describe("manual trajectory instrumentation helpers", () => {
	describe("startAutonomousTick", () => {
		it("starts a trajectory with the full context, opens a timestamped step on it, and returns the trajectory id", async () => {
			const before = Date.now();
			const { service, calls } = createRecordingService({
				trajectoryId: "traj-42",
			});

			const trajectoryId = await startAutonomousTick(service, {
				agentId: "agent-1",
				source: "autonomy",
				scenarioId: "sc-1",
				episodeId: "ep-1",
				batchId: "batch-1",
				metadata: { run: 7 },
			});

			expect(trajectoryId).toBe("traj-42");
			expect(calls.map((call) => call.method)).toEqual([
				"startTrajectory",
				"startStep",
			]);
			expect(calls[0].args[0]).toBe("agent-1");
			expect(calls[0].args[1]).toEqual({
				source: "autonomy",
				scenarioId: "sc-1",
				episodeId: "ep-1",
				batchId: "batch-1",
				metadata: { run: 7 },
			});
			expect(calls[1].args[0]).toBe("traj-42");
			const environmentState = calls[1].args[1] as { timestamp: number };
			expect(environmentState.timestamp).toBeGreaterThanOrEqual(before);
			expect(environmentState.timestamp).toBeLessThanOrEqual(Date.now());
		});

		it("works with only agentId supplied and steps the returned trajectory id", async () => {
			const { service, calls } = createRecordingService();

			const trajectoryId = await startAutonomousTick(service, {
				agentId: "agent-bare",
			});

			expect(trajectoryId).toBe("traj-1");
			expect(calls[0].args[0]).toBe("agent-bare");
			expect(calls[1].args[0]).toBe(trajectoryId);
		});
	});

	describe("endAutonomousTick", () => {
		it("flushes queued writes before ending the trajectory and forwards status and final metrics", async () => {
			const { service, calls } = createRecordingService();

			await endAutonomousTick(service, "traj-9", "error", {
				totalReward: 3.5,
				stepCount: 12,
			});

			expect(calls.map((call) => call.method)).toEqual([
				"flushWriteQueue",
				"endTrajectory",
			]);
			expect(calls[0].args[0]).toBe("traj-9");
			expect(calls[1].args[0]).toBe("traj-9");
			expect(calls[1].args[1]).toBe("error");
			expect(calls[1].args[2]).toEqual({ totalReward: 3.5, stepCount: 12 });
		});

		it('defaults the status to "completed" and passes no final metrics', async () => {
			const { service, calls } = createRecordingService();

			await endAutonomousTick(service, "traj-default");

			expect(calls[1].args[1]).toBe("completed");
			expect(calls[1].args[2]).toBeUndefined();
		});
	});

	describe("loggedLLMCall", () => {
		it("without an active step still executes the call, returns its text, and records nothing", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: null,
			});
			let executions = 0;

			const text = await loggedLLMCall(
				service,
				"traj-nostep",
				{ model: "m-1", systemPrompt: "sys", userPrompt: "usr" },
				async () => {
					executions += 1;
					return { text: "plain answer" };
				},
			);

			expect(text).toBe("plain answer");
			expect(executions).toBe(1);
			expect(calls[0].method).toBe("getCurrentStepId");
			expect(calls[0].args[0]).toBe("traj-nostep");
			expect(calls.filter((call) => call.method === "logLLMCall")).toHaveLength(
				0,
			);
		});

		it("under an active step records the payload against that step with purpose defaulting to action", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-9",
			});

			const text = await loggedLLMCall(
				service,
				"traj-step",
				{
					model: "model-x",
					systemPrompt: "system prompt",
					userPrompt: "user prompt",
				},
				async () => ({
					text: "the answer",
					tokens: { prompt: 11, completion: 4 },
					latencyMs: 321,
				}),
			);

			expect(text).toBe("the answer");
			const recording = calls[calls.length - 1];
			expect(recording.method).toBe("logLLMCall");
			expect(recording.args[0]).toBe("step-9");
			const payload = recording.args[1] as LoggedLLMPayload;
			expect(payload.model).toBe("model-x");
			expect(payload.systemPrompt).toBe("system prompt");
			expect(payload.response).toBe("the answer");
			expect(payload.purpose).toBe("action");
			expect(payload.promptTokens).toBe(11);
			expect(payload.completionTokens).toBe(4);
			expect(payload.latencyMs).toBe(321);
		});

		it("prefers the latency reported by the call over wall-clock measurement", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-latency",
			});

			await loggedLLMCall(
				service,
				"traj-latency",
				{ model: "m", systemPrompt: "s", userPrompt: "u" },
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { text: "ok", latencyMs: 999 };
				},
			);

			const payload = calls[calls.length - 1].args[1] as LoggedLLMPayload;
			expect(payload.latencyMs).toBe(999);
		});

		it("measures wall-clock latency when the call reports none", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-clock",
			});

			await loggedLLMCall(
				service,
				"traj-clock",
				{ model: "m", systemPrompt: "s", userPrompt: "u" },
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 25));
					return { text: "slow" };
				},
			);

			const payload = calls[calls.length - 1].args[1] as LoggedLLMPayload;
			expect(payload.latencyMs).toBeGreaterThanOrEqual(20);
			expect(payload.latencyMs).toBeLessThanOrEqual(5000);
		});

		it("omits optional sampling fields unless provided and forwards explicit values plus actionType", async () => {
			const omitted = createRecordingService({
				currentStepId: "step-omit",
			});
			await loggedLLMCall(
				omitted.service,
				"traj-omit",
				{ model: "m", systemPrompt: "s", userPrompt: "u" },
				async () => ({ text: "t" }),
			);
			const omittedPayload = omitted.calls[omitted.calls.length - 1]
				.args[1] as Record<string, unknown>;
			expect(Object.hasOwn(omittedPayload, "temperature")).toBe(false);
			expect(Object.hasOwn(omittedPayload, "maxTokens")).toBe(false);

			const provided = createRecordingService({
				currentStepId: "step-provide",
			});
			await loggedLLMCall(
				provided.service,
				"traj-provide",
				{
					model: "m",
					systemPrompt: "s",
					userPrompt: "u",
					temperature: 0.2,
					maxTokens: 128,
					actionType: "tool_use",
				},
				async () => ({ text: "t" }),
			);
			const providedPayload = provided.calls[provided.calls.length - 1]
				.args[1] as LoggedLLMPayload;
			expect(providedPayload.temperature).toBe(0.2);
			expect(providedPayload.maxTokens).toBe(128);
			expect(providedPayload.actionType).toBe("tool_use");
		});
	});

	describe("logProviderAccess", () => {
		it("delegates the access record verbatim by trajectory id", () => {
			const { service, calls } = createRecordingService();
			const access = {
				providerName: "openai",
				data: { query: "hello" },
				purpose: "completion",
			};

			logProviderAccess(service, "traj-access", access);

			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe("logProviderAccessByTrajectoryId");
			expect(calls[0].args[0]).toBe("traj-access");
			expect(calls[0].args[1]).toBe(access);
		});
	});

	describe("withTrajectoryLogging", () => {
		it("wraps the function, returns its result unchanged, and completes the active step with reward 0.05", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-wrap",
			});

			const wrapped = withTrajectoryLogging(
				async (left: number, right: number) => left + right,
				service,
				"traj-wrap",
			);

			const result = await wrapped(2, 3);

			expect(result).toBe(5);
			const completing = calls[calls.length - 1];
			expect(completing.method).toBe("completeStep");
			expect(completing.args[0]).toBe("traj-wrap");
			expect(completing.args[1]).toBe("step-wrap");
			const payload = completing.args[2] as CompleteStepPayload;
			expect(payload.actionType).toBe("function_call");
			expect(payload.actionName).toBe("anonymous");
			expect(payload.parameters).toEqual({ args: [2, 3] });
			expect(payload.success).toBe(true);
			expect(payload.result).toEqual({ result: 5 });
			expect(completing.args[3]).toEqual({ reward: 0.05 });
		});

		it("keeps the wrapped function's own name when it has one and forwards a custom action type", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-named",
			});
			async function computePosition(): Promise<number> {
				return 1;
			}

			const wrapped = withTrajectoryLogging(
				computePosition,
				service,
				"traj-named",
				{ actionType: "trade" },
			);
			await wrapped();

			const payload = calls[calls.length - 1].args[2] as CompleteStepPayload;
			expect(payload.actionName).toBe("computePosition");
			expect(payload.actionType).toBe("trade");
		});

		it("records an undefined result as a null result object", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-void",
			});
			const returnsNothing = (async () =>
				undefined) as unknown as () => Promise<number>;

			const wrapped = withTrajectoryLogging(
				returnsNothing,
				service,
				"traj-void",
			);
			await wrapped();

			const payload = calls[calls.length - 1].args[2] as CompleteStepPayload;
			expect(payload.result).toEqual({ result: null });
		});

		it("without an active step runs the function and records nothing", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: null,
			});

			const wrapped = withTrajectoryLogging(
				async () => "bare output",
				service,
				"traj-bare",
			);

			const result = await wrapped();

			expect(result).toBe("bare output");
			expect(
				calls.filter((call) => call.method === "completeStep"),
			).toHaveLength(0);
		});

		it("propagates failures and does not complete the step as successful", async () => {
			const { service, calls } = createRecordingService({
				currentStepId: "step-fail",
			});

			const wrapped = withTrajectoryLogging(
				async () => {
					throw new Error("boom");
				},
				service,
				"traj-fail",
			);

			await expect(wrapped()).rejects.toThrow("boom");
			expect(
				calls.filter((call) => call.method === "completeStep"),
			).toHaveLength(0);
		});
	});
});
