/**
 * Pure dispatch/policy helpers exported by the message service:
 * `isSimpleReplyResponse`, `shouldRunMetadataActionRescue`,
 * `getActionContinuationDecision`, `shouldEmitPlannerPreamble`, and
 * `withActionResultsForPrompt`. These gates decide whether a planned response
 * counts as a simple conversational reply, whether the metadata-overlap rescue
 * may promote a passive response, whether post-action continuation runs, and
 * whether planner text surfaces as a user-visible preamble.
 *
 * Deterministic unit harness over the real module — plain objects, no mocks,
 * no model calls. Every expectation records observed behavior of the module.
 */

import { describe, expect, it } from "vitest";
import type { Action } from "../types/components";
import type { Content } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import {
	getActionContinuationDecision,
	isSimpleReplyResponse,
	shouldEmitPlannerPreamble,
	shouldRunMetadataActionRescue,
	withActionResultsForPrompt,
} from "./message";

function makeAction(name: string, extra: Partial<Action> = {}): Action {
	return {
		name,
		similes: [],
		description: `${name} test action`,
		examples: [],
		validate: async () => true,
		handler: async () => ({ success: true, text: "" }),
		...extra,
	};
}

function runtimeWithActions(actions: Action[]): Pick<IAgentRuntime, "actions"> {
	return { actions };
}

describe("isSimpleReplyResponse", () => {
	it("is true only for a single REPLY-family identifier", () => {
		expect(isSimpleReplyResponse({ actions: ["REPLY"] })).toBe(true);
		// RESPOND is the documented REPLY alias.
		expect(isSimpleReplyResponse({ actions: ["RESPOND"] })).toBe(true);
		expect(isSimpleReplyResponse({ actions: ["reply"] })).toBe(true);
	});

	it("is false for other single control identifiers", () => {
		expect(isSimpleReplyResponse({ actions: ["IGNORE"] })).toBe(false);
		expect(isSimpleReplyResponse({ actions: ["STOP"] })).toBe(false);
		expect(isSimpleReplyResponse({ actions: ["TASKS"] })).toBe(false);
	});

	it("is false when there is no response shape at all", () => {
		expect(isSimpleReplyResponse(null)).toBe(false);
		expect(isSimpleReplyResponse(undefined)).toBe(false);
		expect(isSimpleReplyResponse({} as Pick<Content, "actions">)).toBe(false);
		expect(isSimpleReplyResponse({ actions: [] })).toBe(false);
	});

	it("rejects multi-action plans and non-string entries", () => {
		expect(isSimpleReplyResponse({ actions: ["REPLY", "TASKS"] })).toBe(false);
		expect(
			isSimpleReplyResponse({ actions: [42] } as unknown as Pick<
				Content,
				"actions"
			>),
		).toBe(false);
	});
});

describe("shouldRunMetadataActionRescue", () => {
	it("runs when the planner produced no actions at all", () => {
		expect(shouldRunMetadataActionRescue(null)).toBe(true);
		expect(shouldRunMetadataActionRescue(undefined)).toBe(true);
		expect(shouldRunMetadataActionRescue({} as Pick<Content, "actions">)).toBe(
			true,
		);
		expect(shouldRunMetadataActionRescue({ actions: [] })).toBe(true);
	});

	it("runs for purely passive shapes — NONE, IGNORE, and STOP are not real actions", () => {
		expect(shouldRunMetadataActionRescue({ actions: ["NONE"] })).toBe(true);
		expect(shouldRunMetadataActionRescue({ actions: ["IGNORE"] })).toBe(true);
		expect(shouldRunMetadataActionRescue({ actions: ["STOP"] })).toBe(true);
	});

	it("stands down on explicit REPLY intent", () => {
		expect(shouldRunMetadataActionRescue({ actions: ["REPLY"] })).toBe(false);
		expect(shouldRunMetadataActionRescue({ actions: ["RESPOND"] })).toBe(false);
	});

	it("stands down when any non-passive action is present, even beside REPLY", () => {
		expect(shouldRunMetadataActionRescue({ actions: ["TASKS"] })).toBe(false);
		expect(
			shouldRunMetadataActionRescue({ actions: ["REPLY", "MESSAGE"] }),
		).toBe(false);
	});

	it("ignores non-string action entries for both gates", () => {
		expect(
			shouldRunMetadataActionRescue({
				actions: [42],
			} as unknown as Pick<Content, "actions">),
		).toBe(true);
	});
});

describe("getActionContinuationDecision", () => {
	const runtime = runtimeWithActions([
		makeAction("SPAWN_AGENT_LIKE", { suppressPostActionContinuation: true }),
		makeAction("REAL_ACTION", { similes: ["ALIAS_ONE"] }),
		makeAction("INBOX"),
	]);

	it("returns a neutral decision for absent or empty action plans", () => {
		const expected = {
			shouldContinue: false,
			suppressed: false,
			continuingActions: [],
			suppressingActions: [],
		};
		expect(getActionContinuationDecision(runtime, undefined)).toEqual(expected);
		expect(getActionContinuationDecision(runtime, null)).toEqual(expected);
		expect(getActionContinuationDecision(runtime, { actions: [] })).toEqual(
			expected,
		);
	});

	it("never continues on terminal identifiers, even unregistered ones", () => {
		expect(
			getActionContinuationDecision(runtime, { actions: ["REPLY"] }),
		).toEqual({
			shouldContinue: false,
			suppressed: false,
			continuingActions: [],
			suppressingActions: [],
		});
		expect(
			getActionContinuationDecision(runtime, { actions: ["CREATE_TASK"] }),
		).toEqual({
			shouldContinue: false,
			suppressed: false,
			continuingActions: [],
			suppressingActions: [],
		});
	});

	it("continues on an unregistered non-terminal action", () => {
		expect(
			getActionContinuationDecision(runtime, { actions: ["CHECK_WEATHER"] }),
		).toEqual({
			shouldContinue: true,
			suppressed: false,
			continuingActions: ["CHECK_WEATHER"],
			suppressingActions: [],
		});
	});

	it("suppresses continuation for a turn-owning action", () => {
		expect(
			getActionContinuationDecision(runtime, { actions: ["SPAWN_AGENT_LIKE"] }),
		).toEqual({
			shouldContinue: false,
			suppressed: true,
			continuingActions: [],
			suppressingActions: ["SPAWN_AGENT_LIKE"],
		});
	});

	it("reports suppression as winning over continuing siblings, listing both", () => {
		expect(
			getActionContinuationDecision(runtime, {
				actions: ["SPAWN_AGENT_LIKE", "CHECK_WEATHER"],
			}),
		).toEqual({
			shouldContinue: false,
			suppressed: true,
			continuingActions: ["CHECK_WEATHER"],
			suppressingActions: ["SPAWN_AGENT_LIKE"],
		});
	});

	it("resolves a simile to the canonical parent action name before classifying it", () => {
		expect(
			getActionContinuationDecision(runtime, { actions: ["alias_one"] }),
		).toEqual({
			shouldContinue: true,
			suppressed: false,
			continuingActions: ["REAL_ACTION"],
			suppressingActions: [],
		});
	});

	it("skips non-string action entries entirely", () => {
		expect(
			getActionContinuationDecision(runtime, {
				actions: [{ name: "GHOST" } as unknown as string],
			}),
		).toEqual({
			shouldContinue: false,
			suppressed: false,
			continuingActions: [],
			suppressingActions: [],
		});
	});
});

describe("shouldEmitPlannerPreamble", () => {
	const actions = [
		makeAction("SPAWN_AGENT_LIKE", { suppressPostActionContinuation: true }),
		makeAction("INBOX"),
	];
	const runtime = { actions } as unknown as IAgentRuntime;

	it("requires both non-empty planner text and a leading string action", () => {
		expect(shouldEmitPlannerPreamble(runtime, null)).toBe(false);
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "   ", actions: ["INBOX"] }),
		).toBe(false);
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "checking", actions: [] }),
		).toBe(false);
	});

	it("never emits for REPLY, IGNORE, or STOP as the first action", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "here you go",
				actions: ["REPLY"],
			}),
		).toBe(false);
		expect(
			shouldEmitPlannerPreamble(runtime, { text: "ok", actions: ["IGNORE"] }),
		).toBe(false);
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "stopping",
				actions: ["STOP"],
			}),
		).toBe(false);
	});

	it("emits for a registered ordinary action and for unregistered actions", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "checking your inbox",
				actions: ["INBOX"],
			}),
		).toBe(true);
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "looking outside",
				actions: ["CHECK_WEATHER"],
			}),
		).toBe(true);
	});

	it("does not emit when the first action owns the turn", () => {
		expect(
			shouldEmitPlannerPreamble(runtime, {
				text: "spawning the agent",
				actions: ["SPAWN_AGENT_LIKE"],
			}),
		).toBe(false);
	});
});

describe("withActionResultsForPrompt", () => {
	function baseState(): State {
		return {
			values: { existingValue: "keep-me" },
			data: { existingData: 7 },
			text: "",
		};
	}

	it("renders prompt-facing text into values and keeps raw results on data", () => {
		const state = baseState();
		const result = withActionResultsForPrompt(state, [
			{ success: true, text: "did the thing", data: { actionName: "INBOX" } },
		]);

		expect(result.values.actionResults).toBe(
			'# Current Chain Action Results\n\n1. INBOX - succeeded\n{"success":true,"text":"did the thing","data":{"actionName":"INBOX"}}',
		);
		expect(result.data.actionResults).toHaveLength(1);
		expect(result.data.actionResults?.[0]).toMatchObject({
			success: true,
			text: "did the thing",
		});
		// Pre-existing values and data survive the merge.
		expect(result.values.existingValue).toBe("keep-me");
		expect(result.data.existingData).toBe(7);
	});

	it("renders an explicit placeholder when there are no action results", () => {
		const result = withActionResultsForPrompt(baseState(), []);
		expect(result.values.actionResults).toBe("No action results available.");
		expect(result.data.actionResults).toEqual([]);
	});

	it("does not mutate the input state", () => {
		const state = baseState();
		withActionResultsForPrompt(state, [{ success: false, text: "boom" }]);
		expect(state.values.actionResults).toBeUndefined();
		expect(state.data.actionResults).toBeUndefined();
		expect(Object.keys(state.values)).toEqual(["existingValue"]);
		expect(Object.keys(state.data)).toEqual(["existingData"]);
	});
});
