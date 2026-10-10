/** A provider's child trajectory step starts at its first model capture; a provider that calls no model leaves none. */
import { expect, it } from "vitest";
import { runWithTrajectoryContext } from "../src/trajectory-context";
import {
	ensureTaskTrajectory,
	logActiveTrajectoryLlmCall,
	type TrajectoryLlmCallDetails,
	withProviderStep,
} from "../src/trajectory-utils";
import type { IAgentRuntime } from "../src/types/runtime";

function fixture() {
	const started: Array<{ parentStepId?: string; kind?: string }> = [];
	const logged: string[] = [];
	const logger = {
		isEnabled: () => true,
		startStep: (_trajectoryId: string, state: Record<string, unknown>) => {
			started.push(state);
			return `child-${started.length}`;
		},
		logLlmCall: (call: { stepId: string }) => {
			logged.push(call.stepId);
		},
	};
	const runtime = {
		agentId: "00000000-0000-4000-8000-000000000001",
		getService: (type: string) => (type === "trajectories" ? logger : null),
		getServicesByType: (type: string) =>
			type === "trajectories" ? [logger] : [],
		reportError: () => {},
	} as unknown as IAgentRuntime;
	return { runtime, started, logged };
}

const call = {
	model: "test-model",
	systemPrompt: "",
	userPrompt: "summarize",
	response: "ok",
	temperature: 0,
	maxTokens: 10,
	purpose: "provider",
	actionType: "test.generate",
	latencyMs: 1,
} as TrajectoryLlmCallDetails;

const turn = { trajectoryId: "trajectory-1", trajectoryStepId: "parent-step" };

// Most providers call no model, so an eager child step would persist an empty
// row for each of them.
it("persists no child step for a provider that calls no model", async () => {
	const { runtime, started } = fixture();
	await runWithTrajectoryContext({ ...turn }, () =>
		withProviderStep(runtime, "QUIET", () => "provider text"),
	);
	expect(started).toEqual([]);
});

it("records a provider's model calls on one child step started at the first call", async () => {
	const { runtime, started, logged } = fixture();
	await runWithTrajectoryContext({ ...turn }, () =>
		withProviderStep(runtime, "SUMMARY", async () => {
			await ensureTaskTrajectory();
			logActiveTrajectoryLlmCall(runtime, call);
			logActiveTrajectoryLlmCall(runtime, call);
		}),
	);
	expect(started).toEqual([
		expect.objectContaining({ parentStepId: "parent-step", kind: "llm" }),
	]);
	expect(logged).toEqual(["child-1", "child-1"]);
});
