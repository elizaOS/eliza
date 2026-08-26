/**
 * Evidence-grounded completion guarantee: a finished planner turn whose final
 * reply asserts delegated work finished, while the turn's own tool evidence
 * reports a terminal failure/interrupted status, must ship a failure-grounded
 * synthesis (or the typed honest fallback) — never the fabricated completion.
 * Pinned to the live incident (2026-08-25, tj-f725640b30e703): TASKS history
 * said the task was "[interrupted]" with no results and the gated terminal
 * REPLY shipped "it's finished. it looks like we're using chart.js now."
 * Deterministic — `useModel`, `executeToolCall`, and `evaluate` are vitest
 * mocks; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
	CONTRADICTED_COMPLETION_FALLBACK_MESSAGE,
	runPlannerLoop,
} from "../planner-loop";

type MockedMessages = {
	messages?: Array<{ role?: string; content?: unknown }>;
};

/** Text of the loop-composed instruction blocks fed to a given model call. */
function loopComposedInstructionText(
	useModel: ReturnType<typeof vi.fn>,
	callIndex: number,
	marker: string,
): string {
	const params = useModel.mock.calls[callIndex]?.[1] as
		| MockedMessages
		| undefined;
	return (params?.messages ?? [])
		.map((message) =>
			typeof message.content === "string" ? message.content : "",
		)
		.filter((content) => content.includes(marker))
		.join("\n");
}

// The byte-exact incident payloads (trajectory tj-f725640b30e703).
const INCIDENT_TASKS_HISTORY_TEXT =
	'The most recent orchestrator task is "Chart Dependency Investigation" [interrupted].\n' +
	"Task id: cb6820c6-fc7d-4068-9f33-11f281e24305\n" +
	"Latest session: chart-dep-check\n" +
	"Workspace: /home/milady/.eliza/workspaces/task-4b374a1a\n" +
	"Latest activity: 2026-08-25T08:06:12.157Z";
const INCIDENT_FABRICATED_REPLY =
	"it's finished. it looks like we're using chart.js now.";

const TASKS_TOOL = [
	{ name: "TASKS", description: "Coding sub-agent task operations." },
];

function tasksThenReplyPlanner(
	replyText: string,
	toolResultText: string,
	synthesisText?: string,
) {
	const useModel = vi
		.fn()
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "TASKS",
					arguments: { action: "history", search: "chart-dep-check" },
				},
			],
		})
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{ id: "call-2", name: "REPLY", arguments: { text: replyText } },
			],
		});
	if (synthesisText !== undefined) {
		useModel.mockResolvedValueOnce({ text: synthesisText, toolCalls: [] });
	}
	const executeToolCall = vi.fn(async () => ({
		success: true,
		text: toolResultText,
	}));
	// Mirrors the incident: the evaluator saw the first iteration and sent
	// CONTINUE; the second iteration's terminal REPLY is gated (no LLM call).
	const evaluate = vi.fn(async () => ({
		success: false,
		decision: "CONTINUE" as const,
		thought: "only 1 tool operation(s) succeeded — continuing.",
	}));
	return { useModel, executeToolCall, evaluate };
}

describe("evidence-grounded completion guarantee", () => {
	it("replaces the incident's fabricated completion with the failure-grounded synthesis", async () => {
		const honest =
			"that build didn't finish — the task tracker shows the chart dependency investigation was interrupted before it produced anything. want me to restart it?";
		const { useModel, executeToolCall, evaluate } = tasksThenReplyPlanner(
			INCIDENT_FABRICATED_REPLY,
			INCIDENT_TASKS_HISTORY_TEXT,
			honest,
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: TASKS_TOOL,
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(honest);
		expect(result.finalMessage).not.toContain("chart.js");

		// The forced-synthesis instruction names the contradicting tool and
		// quotes the terminal-status evidence line.
		const instruction = loopComposedInstructionText(
			useModel,
			2,
			"Tool-reported status",
		);
		expect(instruction).toContain("TASKS result");
		expect(instruction).toContain("[interrupted]");
		expect(instruction).toContain("do not invent results");
	});

	it("leaves a completion claim alone when the evidence reports verified success", async () => {
		const { useModel, executeToolCall, evaluate } = tasksThenReplyPlanner(
			"it's finished.",
			'The most recent orchestrator task is "Chart Dependency Investigation" [done]. Every acceptance criterion passes.',
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: TASKS_TOOL,
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe("it's finished.");
	});

	it("leaves an honest failure reply alone even with terminal-failure evidence", async () => {
		const honestReply =
			"that build failed before finishing — the session was interrupted. want me to retry it?";
		const { useModel, executeToolCall, evaluate } = tasksThenReplyPlanner(
			honestReply,
			INCIDENT_TASKS_HISTORY_TEXT,
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: TASKS_TOOL,
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(honestReply);
	});

	it("ships the typed honest fallback when the forced synthesis returns nothing usable", async () => {
		const { useModel, executeToolCall, evaluate } = tasksThenReplyPlanner(
			INCIDENT_FABRICATED_REPLY,
			INCIDENT_TASKS_HISTORY_TEXT,
			"",
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: TASKS_TOOL,
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(CONTRADICTED_COMPLETION_FALLBACK_MESSAGE);
	});

	it("ships the typed honest fallback when the synthesis itself still claims completion", async () => {
		const { useModel, executeToolCall, evaluate } = tasksThenReplyPlanner(
			INCIDENT_FABRICATED_REPLY,
			INCIDENT_TASKS_HISTORY_TEXT,
			"it's finished. everything went great.",
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: TASKS_TOOL,
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(CONTRADICTED_COMPLETION_FALLBACK_MESSAGE);
	});
});
