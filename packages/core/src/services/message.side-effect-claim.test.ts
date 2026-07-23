/**
 * Stage-1 fabricated side-effect guard: `replyClaimsCompletedSideEffect` shape
 * detection plus the `core.simple_completed_side_effect_claim` response-handler
 * evaluator's reroute-to-planner patch. Runs against a REAL AgentRuntime
 * (PGLite-backed, no mocks) so the backstop-rule registry and evaluator wiring
 * are exercised on the production architecture; no live model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringToUuid } from "../index";
import { registerCandidateActionBackstopRule } from "../runtime/candidate-action-backstop";
import type {
	ResponseHandlerEvaluatorContext,
	ResponseHandlerPatch,
} from "../runtime/response-handler-evaluators";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "../testing/pglite-runtime";
import type { MessageHandlerResult } from "../types/components";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	replyClaimsCompletedSideEffect,
} from "./message";

const CLAIM_EVALUATOR_NAME = "core.simple_completed_side_effect_claim";

let testRuntime: TestRuntimeResult;

beforeAll(async () => {
	testRuntime = await createTestRuntime();
}, 180_000);

afterAll(async () => {
	await testRuntime.cleanup();
});

function getClaimEvaluator() {
	const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
		(candidate) => candidate.name === CLAIM_EVALUATOR_NAME,
	);
	if (!evaluator) {
		throw new Error(`${CLAIM_EVALUATOR_NAME} is not registered`);
	}
	return evaluator;
}

function simpleReplyHandler(reply: string): MessageHandlerResult {
	return {
		processMessage: "RESPOND",
		thought: "test",
		plan: { contexts: ["simple"], reply, simple: true },
	};
}

function makeContext(
	messageHandler: MessageHandlerResult,
): ResponseHandlerEvaluatorContext {
	const runtime = testRuntime.runtime;
	const message: Memory = {
		id: stringToUuid("side-effect-claim-test-message"),
		entityId: stringToUuid("side-effect-claim-test-entity"),
		agentId: runtime.agentId,
		roomId: stringToUuid("side-effect-claim-test-room"),
		content: { text: "help me not forget the bill", source: "test" },
		createdAt: Date.now(),
	};
	const state: State = { values: {}, data: {}, text: "" };
	return {
		runtime,
		message,
		state,
		messageHandler,
		availableContexts: [],
	};
}

describe("replyClaimsCompletedSideEffect", () => {
	it("matches fabricated completed-scheduling claims", () => {
		expect(
			replyClaimsCompletedSideEffect(
				"Done — you won't let it slip. I've set two reminders: July 27 at 9am and July 28 at 9am.",
			),
		).toBe(true);
		expect(
			replyClaimsCompletedSideEffect(
				"All right, I have scheduled the check-in.",
			),
		).toBe(true);
		expect(
			replyClaimsCompletedSideEffect("Your reminders are set for tomorrow."),
		).toBe(true);
	});

	it("matches bare simple-past assertions and perfective claims with a tag question", () => {
		// "I set" with no auxiliary is still a report when the sentence is
		// declarative — the fabrication does not need "I've" to be a claim.
		expect(
			replyClaimsCompletedSideEffect("I set a reminder for the 28th at 9am."),
		).toBe(true);
		expect(
			replyClaimsCompletedSideEffect("I added it to your calendar for Tuesday."),
		).toBe(true);
		// A perfective assertion stays a claim even when a consent tag follows in
		// the same sentence — the completed-work assertion already happened.
		expect(
			replyClaimsCompletedSideEffect(
				"I've set two reminders — anything else?",
			),
		).toBe(true);
	});

	it("passes offers, questions, and honest denials through", () => {
		expect(
			replyClaimsCompletedSideEffect(
				"Want me to set a reminder for the 27th? Say the word and it's done.",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect("I have not set any reminders yet."),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect("I can set a reminder if you'd like."),
		).toBe(false);
		expect(replyClaimsCompletedSideEffect("The capital is Paris.")).toBe(false);
	});

	// Regression (#16966 post-merge review): consent-seeking offers phrased
	// with a modal before "I" matched the old adjacency pattern ("Should I
	// set…"), got rewritten to "On it.", and forced an unwanted planner run —
	// the user asked a question and received an action instead of an answer.
	it("passes consent-seeking offer phrasings through", () => {
		expect(
			replyClaimsCompletedSideEffect("Want me to set a reminder for tomorrow?"),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect("Should I set a reminder for tomorrow?"),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect("Shall I set a reminder for the 28th?"),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect("Do you want me to set a reminder?"),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"I can set a reminder for tomorrow morning — want me to?",
			),
		).toBe(false);
	});

	it("passes question phrasings and clarifying interrogatives through", () => {
		expect(
			replyClaimsCompletedSideEffect(
				"Before I set the reminder, what time works?",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"When I set reminders, mornings usually work best — should I?",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"Would you like me to add it to your calendar?",
			),
		).toBe(false);
	});

	it("passes conditional and not-yet-done phrasings through", () => {
		expect(
			replyClaimsCompletedSideEffect(
				"I could set a reminder for the 28th if you like.",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"Once I've set the reminder, I'll confirm the time.",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"If I set a reminder for 9am, would that work?",
			),
		).toBe(false);
	});

	it("requires a schedulable subject, not just a completion verb", () => {
		expect(
			replyClaimsCompletedSideEffect("I've set aside my doubts about this."),
		).toBe(false);
	});

	it("anchors the bare 'done —' branch to reply or sentence start", () => {
		// Reply-start "Done —" is a completion claim (also carried by "I've set").
		expect(
			replyClaimsCompletedSideEffect("Done — I've set two reminders."),
		).toBe(true);
		// The anchored branch alone: no completion verb, no "are set" phrasing.
		expect(replyClaimsCompletedSideEffect("Done — two reminders.")).toBe(true);
		// Sentence-start mid-reply still counts.
		expect(
			replyClaimsCompletedSideEffect(
				"Both are handled. Done — see your reminders list.",
			),
		).toBe(true);
		// "All done —" is caught via the "reminders are set" branch, not "done —".
		expect(
			replyClaimsCompletedSideEffect("All done — reminders are set."),
		).toBe(true);
		// Congratulations must pass through: "done —" mid-sentence is not a claim.
		expect(
			replyClaimsCompletedSideEffect("Well done — that's every task cleared."),
		).toBe(false);
	});
});

describe(CLAIM_EVALUATOR_NAME, () => {
	it("fires only on simple-path replies that claim a completed side effect", async () => {
		const evaluator = getClaimEvaluator();
		expect(
			await evaluator.shouldRun(
				makeContext(simpleReplyHandler("Done — I've set two reminders.")),
			),
		).toBe(true);
		expect(
			await evaluator.shouldRun(
				makeContext(simpleReplyHandler("Want me to set a reminder?")),
			),
		).toBe(false);
		expect(
			await evaluator.shouldRun(
				makeContext(
					simpleReplyHandler("Should I set a reminder for tomorrow?"),
				),
			),
		).toBe(false);
		// Already-planning turns are out of scope: a tool will run for real.
		const planning = simpleReplyHandler("Done — I've set two reminders.");
		planning.plan.requiresTool = true;
		expect(await evaluator.shouldRun(makeContext(planning))).toBe(false);
		const nonSimple = simpleReplyHandler("Done — I've set two reminders.");
		nonSimple.plan.contexts = ["simple", "general"];
		expect(await evaluator.shouldRun(makeContext(nonSimple))).toBe(false);
	});

	// Ordered before the rule-registration case: the backstop registry is
	// WeakMap-keyed on the shared real runtime, so this must observe the
	// pre-registration state.
	it("still reroutes (candidate-less) when no backstop rule matches", async () => {
		const evaluator = getClaimEvaluator();
		const patch = (await evaluator.evaluate(
			makeContext(
				simpleReplyHandler("Done — I've set two reminders for your bill."),
			),
		)) as ResponseHandlerPatch;
		expect(patch.requiresTool).toBe(true);
		expect(patch.addCandidateActions).toBeUndefined();
		expect(patch.reply).toBe("On it.");
	});

	it("reroutes to the planner with backstop-rule candidates and an honest ack", async () => {
		const evaluator = getClaimEvaluator();
		registerCandidateActionBackstopRule(testRuntime.runtime, {
			actionNames: ["SCHEDULED_TASKS", "SCHEDULED_TASKS_CREATE"],
			matches: (text) => /\breminders?\b/i.test(text),
		});
		const patch = (await evaluator.evaluate(
			makeContext(
				simpleReplyHandler("Done — I've set two reminders for your bill."),
			),
		)) as ResponseHandlerPatch;
		expect(patch.requiresTool).toBe(true);
		expect(patch.addContexts).toEqual(["general"]);
		expect(patch.addCandidateActions).toEqual([
			"SCHEDULED_TASKS",
			"SCHEDULED_TASKS_CREATE",
		]);
		// The fabricated confirmation must never ship — replaced by a plain ack
		// the planner path then supersedes with a tool-grounded reply.
		expect(patch.reply).toBe("On it.");
	});
});
