/**
 * Covers the evaluator's errored-stage evidence contract: when the post-tool
 * evaluator MODEL CALL itself throws (the live failure mode is an intermittent
 * provider 400 whose request was previously persisted nowhere), runEvaluator
 * must record an `evaluation` stage carrying the REQUEST messages and the
 * provider's real error detail before rethrowing. Deterministic — mocked
 * useModel/recorder, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { runEvaluator } from "../evaluator";
import type { RecordedStage } from "../trajectory-recorder";

function providerBadRequest(): Error {
	return Object.assign(new Error("Bad Request"), {
		statusCode: 400,
		responseBody:
			'{"message":"Encountered a server error, please try again","type":"server_error"}',
		url: "https://api.cerebras.ai/v1/chat/completions",
	});
}

const CONTEXT = {
	id: "ctx",
	staticPrefix: {
		characterPrompt: { content: "agent_name: Eliza", stable: true },
	},
	events: [
		{
			id: "msg",
			type: "message",
			message: { role: "user", content: { text: "remember my color." } },
		},
	],
};

const TRAJECTORY = {
	context: { id: "ctx" },
	steps: [
		{
			iteration: 2,
			terminalOnly: true,
			terminalMessage: "EVALUATOR_STAGE_TERMINAL_NEVER_SHOW",
		},
	],
	archivedSteps: [
		{
			iteration: 1,
			thought: "EVALUATOR_STAGE_THOUGHT_NEVER_SHOW",
			toolCall: {
				id: "EVALUATOR_STAGE_ID_NEVER_SHOW",
				name: "MEMORY_CREATE",
				params: { text: "EVALUATOR_STAGE_PARAM_NEVER_SHOW" },
			},
			result: {
				success: true,
				text: "EVALUATOR_STAGE_RESULT_NEVER_SHOW",
				data: { secret: "EVALUATOR_STAGE_DATA_NEVER_SHOW" },
				error: "EVALUATOR_STAGE_ERROR_NEVER_SHOW",
			},
		},
	],
	plannedQueue: [],
	evaluatorOutputs: [],
};

describe("runEvaluator — errored evaluation stage evidence", () => {
	it("records the request messages and provider detail, then rethrows", async () => {
		const recorded: Array<{ trajectoryId: string; stage: RecordedStage }> = [];
		const recorder = {
			recordStage: vi.fn(async (trajectoryId: string, stage: RecordedStage) => {
				recorded.push({ trajectoryId, stage });
			}),
		};
		const runtime = {
			useModel: vi.fn(async () => {
				throw providerBadRequest();
			}),
		};

		await expect(
			runEvaluator({
				runtime,
				recorder: recorder as never,
				trajectoryId: "tj-test",
				iteration: 1,
				context: CONTEXT,
				trajectory: TRAJECTORY,
				effects: {},
			}),
		).rejects.toThrow("Bad Request");

		expect(recorded).toHaveLength(1);
		const stage = recorded[0]?.stage;
		expect(recorded[0]?.trajectoryId).toBe("tj-test");
		expect(stage?.kind).toBe("evaluation");
		// The recorded REQUEST is exactly what the provider received: original
		// context plus typed machine authority, never the process-local envelope.
		const messages = stage?.model?.messages ?? [];
		expect(messages).toHaveLength(2);
		const roles = messages.map((m) => m.role);
		expect(roles).toEqual(["system", "user"]);
		const request = JSON.stringify(messages);
		expect(request).toContain("tool_authority");
		expect(request).toContain("machine_status: success");
		expect(request).not.toMatch(
			/EVALUATOR_STAGE_(?:THOUGHT|ID|PARAM|RESULT|DATA|ERROR|TERMINAL)_NEVER_SHOW/,
		);
		// The provider's real diagnostic (recovered from responseBody) is on the
		// recorded response, not just the masked statusText.
		expect(String(stage?.model?.response ?? "")).toContain(
			"evaluator model call failed",
		);
		expect(String(stage?.model?.response ?? "")).toContain("please try again");
		expect(String(stage?.model?.response ?? "")).toContain("400");
		// The failure is marked as a non-decision so downstream consumers cannot
		// mistake it for a model verdict.
		expect(stage?.evaluation?.protocolFailure).toBe(true);
	});

	it("does not swallow the model error when no recorder is attached", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				throw providerBadRequest();
			}),
		};
		await expect(
			runEvaluator({
				runtime,
				context: CONTEXT,
				trajectory: TRAJECTORY,
				effects: {},
			}),
		).rejects.toThrow("Bad Request");
	});
});
