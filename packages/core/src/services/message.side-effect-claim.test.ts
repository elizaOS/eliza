/**
 * Stage-1 fabricated state-claim guards: `replyClaimsCompletedSideEffect` /
 * `replyClaimsEmptyTrackedWorkState` shape detection, the
 * `core.simple_completed_side_effect_claim` and
 * `core.simple_empty_tracked_state_claim` response-handler evaluators'
 * reroute-to-planner patches, and the planned-reply egress guard
 * (`evaluatePlannedReplyEgress`) that bounces a bare planner REPLY carrying an
 * ungrounded claim. Runs against a REAL AgentRuntime (PGLite-backed, no mocks)
 * so the backstop-rule registry and evaluator wiring are exercised on the
 * production architecture; no live model.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringToUuid } from "../index";
import { registerCandidateActionBackstopRule } from "../runtime/candidate-action-backstop";
import { getDefaultContextDefinitions } from "../runtime/default-contexts";
import type {
	ResponseHandlerEvaluatorContext,
	ResponseHandlerPatch,
} from "../runtime/response-handler-evaluators";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "../testing/pglite-runtime";
import type { ActionResult, MessageHandlerResult } from "../types/components";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	evaluatePlannedReplyEgress,
	formatAvailableContextsForPrompt,
	plannedReplyHasGroundingActionResult,
	registeredTrackedWorkContexts,
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
} from "./message";

const CLAIM_EVALUATOR_NAME = "core.simple_completed_side_effect_claim";
const EMPTY_CLAIM_EVALUATOR_NAME = "core.simple_empty_tracked_state_claim";

// The byte-exact fabricated empty-day reply from #17058 run 729acaf2: a recap
// ask routed contexts=["simple"] and invented an absent day with no read tool.
const FABRICATED_EMPTY_DAY_REPLY =
	"I don't have today's log in front of me — no notes, tasks, or messages from earlier today.";

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
	options?: {
		runtime?: ResponseHandlerEvaluatorContext["runtime"];
		userText?: string;
	},
): ResponseHandlerEvaluatorContext {
	const runtime = options?.runtime ?? testRuntime.runtime;
	const message: Memory = {
		id: stringToUuid("side-effect-claim-test-message"),
		entityId: stringToUuid("side-effect-claim-test-entity"),
		agentId: runtime.agentId,
		roomId: stringToUuid("side-effect-claim-test-room"),
		content: {
			text: options?.userText ?? "help me not forget the bill",
			source: "test",
		},
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
		// Live L1 shapes (#16941): bare completion opener and "is now set up".
		expect(
			replyClaimsCompletedSideEffect(
				"Saved! ✅ Your book report plan is now set up as reminders.",
			),
		).toBe(true);
		expect(
			replyClaimsCompletedSideEffect(
				"Your study schedule is now set up — three blocks before Thursday.",
			),
		).toBe(true);
	});

	it("does not flag descriptions of existing scheduled state", () => {
		expect(
			replyClaimsCompletedSideEffect(
				"Your dentist appointment is scheduled for Tuesday at 3pm.",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect("Saved by the bell — great show."),
		).toBe(false);
	});

	it("matches bare simple-past assertions and perfective claims with a tag question", () => {
		// "I set" with no auxiliary is still a report when the sentence is
		// declarative — the fabrication does not need "I've" to be a claim.
		expect(
			replyClaimsCompletedSideEffect("I set a reminder for the 28th at 9am."),
		).toBe(true);
		expect(
			replyClaimsCompletedSideEffect(
				"I added it to your calendar for Tuesday.",
			),
		).toBe(true);
		// A perfective assertion stays a claim even when a consent tag follows in
		// the same sentence — the completed-work assertion already happened.
		expect(
			replyClaimsCompletedSideEffect("I've set two reminders — anything else?"),
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

describe("setup-completion claims (#16941)", () => {
	it("flags 'you're all set with sensible defaults' as a fabricated setup claim", () => {
		// Live failure (first-run fast-start): a fresh boot "set me up" ask was
		// answered "You're all set with sensible defaults" with zero tool calls
		// and no first-run flow engagement.
		expect(
			replyClaimsCompletedSideEffect(
				"You're all set with sensible defaults — no fiddling needed.",
			),
		).toBe(true);
		expect(
			replyClaimsCompletedSideEffect("Your setup is now set up and ready."),
		).toBe(true);
	});

	it("does not flag honest setup offers or questions", () => {
		expect(
			replyClaimsCompletedSideEffect(
				"I can set you up with sensible defaults — what time do you usually wake up?",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"Setup hasn't run yet. Want defaults, or a quick customize?",
			),
		).toBe(false);
	});
});

describe("replyClaimsEmptyTrackedWorkState", () => {
	it("matches the live #17058 fabricated empty-day reply", () => {
		expect(replyClaimsEmptyTrackedWorkState(FABRICATED_EMPTY_DAY_REPLY)).toBe(
			true,
		);
	});

	it("matches empty-list / empty-day assertions", () => {
		expect(
			replyClaimsEmptyTrackedWorkState("Your task list is empty right now."),
		).toBe(true);
		expect(
			replyClaimsEmptyTrackedWorkState(
				"No tasks logged today — you had a quiet one.",
			),
		).toBe(true);
		expect(
			replyClaimsEmptyTrackedWorkState("I don't have today's log, sorry."),
		).toBe(true);
		expect(
			replyClaimsEmptyTrackedWorkState(
				"Nothing was recorded this morning, so there is nothing to recap.",
			),
		).toBe(true);
		expect(
			replyClaimsEmptyTrackedWorkState("There's nothing on your list."),
		).toBe(true);
		expect(
			replyClaimsEmptyTrackedWorkState("Your day is wide open tomorrow."),
		).toBe(true);
	});

	it("passes questions and conditionals through", () => {
		expect(
			replyClaimsEmptyTrackedWorkState("Is your task list empty right now?"),
		).toBe(false);
		expect(
			replyClaimsEmptyTrackedWorkState(
				"If your task list is empty, we could plan tomorrow instead.",
			),
		).toBe(false);
	});

	it("passes ordinary non-task chat through", () => {
		expect(
			replyClaimsEmptyTrackedWorkState(
				"No word from Bob today — his last message was yesterday.",
			),
		).toBe(false);
		expect(
			replyClaimsEmptyTrackedWorkState("The capital of France is Paris."),
		).toBe(false);
		// Honest process talk about the assistant's own limits, not the user's day.
		expect(
			replyClaimsEmptyTrackedWorkState(
				"I wasn't able to check your tracked tasks and notes just now, so I can't give you an accurate picture of the day. Want me to try again?",
			),
		).toBe(false);
	});
});

describe(EMPTY_CLAIM_EVALUATOR_NAME, () => {
	function getEmptyClaimEvaluator() {
		const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
			(candidate) => candidate.name === EMPTY_CLAIM_EVALUATOR_NAME,
		);
		if (!evaluator) {
			throw new Error(`${EMPTY_CLAIM_EVALUATOR_NAME} is not registered`);
		}
		return evaluator;
	}

	// A runtime with no tasks-class surface genuinely cannot look the answer
	// up, so the reply is an honest capability statement there and must pass
	// through. The default runtime already ships a tracked-work action (core
	// TASKS declares the "tasks" context), so the empty-surface case is
	// exercised by removing those actions for the duration of the assertion.
	it("does not fire when no tracked-work action is registered", async () => {
		const runtime = testRuntime.runtime;
		expect(registeredTrackedWorkContexts(runtime).length).toBeGreaterThan(0);
		const original = [...runtime.actions];
		const untracked = original.filter(
			(action) =>
				registeredTrackedWorkContexts({ actions: [action] }).length === 0,
		);
		runtime.actions.length = 0;
		runtime.actions.push(...untracked);
		try {
			expect(registeredTrackedWorkContexts(runtime)).toEqual([]);
			expect(
				await getEmptyClaimEvaluator().shouldRun(
					makeContext(simpleReplyHandler(FABRICATED_EMPTY_DAY_REPLY), {
						userText: "Recap my day — what did I get done today?",
					}),
				),
			).toBe(false);
		} finally {
			runtime.actions.length = 0;
			runtime.actions.push(...original);
		}
	});

	it("fires on a simple-path empty-day claim once tracked-work actions exist, and reroutes with tracked contexts + backstop candidates", async () => {
		const runtime = testRuntime.runtime;
		runtime.registerAction({
			name: "SCHEDULED_TASKS",
			description: "tracked-work test action",
			contexts: ["tasks", "productivity"],
			validate: async () => true,
			handler: async () => ({ success: true, text: "" }),
		});
		registerCandidateActionBackstopRule(runtime, {
			actionNames: ["SCHEDULED_TASKS", "SCHEDULED_TASKS_LIST"],
			matches: (text) => /\b(?:recap|tasks?)\b/i.test(text),
		});
		const evaluator = getEmptyClaimEvaluator();
		const context = makeContext(
			simpleReplyHandler(FABRICATED_EMPTY_DAY_REPLY),
			{ userText: "Recap my day — what did I get done today?" },
		);
		expect(await evaluator.shouldRun(context)).toBe(true);
		const patch = (await evaluator.evaluate(context)) as ResponseHandlerPatch;
		expect(patch.requiresTool).toBe(true);
		// Reroute contexts: up to two tracked-work ids the registered actions
		// declare (registration order decides which two), then "general".
		expect(patch.addContexts?.at(-1)).toBe("general");
		expect(patch.addContexts).toContain("tasks");
		expect(patch.addContexts?.length).toBeLessThanOrEqual(3);
		expect(patch.addCandidateActions).toEqual([
			"SCHEDULED_TASKS",
			"SCHEDULED_TASKS_LIST",
		]);
		// The fabricated empty day must never ship — replaced by a plain ack the
		// planner path then supersedes with a tool-grounded recap.
		expect(patch.reply).toBe("On it.");
	});

	it("does not fire on non-task chat or on already-planning turns", async () => {
		const evaluator = getEmptyClaimEvaluator();
		expect(
			await evaluator.shouldRun(
				makeContext(
					simpleReplyHandler(
						"No word from Bob today — his last message was yesterday.",
					),
				),
			),
		).toBe(false);
		// A non-simple routed turn grounds through the planner; the egress guard
		// below owns that path, not the Stage-1 evaluator.
		const planning = simpleReplyHandler(FABRICATED_EMPTY_DAY_REPLY);
		planning.plan.contexts = ["simple", "tasks"];
		expect(await evaluator.shouldRun(makeContext(planning))).toBe(false);
	});
});

describe("evaluatePlannedReplyEgress", () => {
	const FABRICATED_ALL_SET_REPLY =
		"You're all set — I've seeded your first reminder for tomorrow at 9am.";

	it("bounces a bare planner REPLY that claims completed work with zero executed actions", () => {
		const decision = evaluatePlannedReplyEgress({
			reply: FABRICATED_ALL_SET_REPLY,
			hasGroundingActionResult: false,
			trackedWorkContexts: ["tasks"],
		});
		expect(decision.verdict).toBe("bounce");
		if (decision.verdict !== "bounce") throw new Error("expected bounce");
		expect(decision.kind).toBe("completed_side_effect");
		// The corrective instruction quotes the rejected claim so the re-run
		// knows exactly what was refused.
		expect(decision.correctiveInstruction).toContain("all set");
		// The honest fallback must not itself trip either claim detector.
		expect(replyClaimsCompletedSideEffect(decision.fallbackReply)).toBe(false);
		expect(replyClaimsEmptyTrackedWorkState(decision.fallbackReply)).toBe(
			false,
		);
	});

	it("allows the same claim when a successful non-control tool grounded it", () => {
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_ALL_SET_REPLY,
				hasGroundingActionResult: true,
				trackedWorkContexts: ["tasks"],
			}),
		).toEqual({ verdict: "allow" });
	});

	it("bounces an ungrounded empty-day claim only when a tracked-work surface exists", () => {
		const bounced = evaluatePlannedReplyEgress({
			reply: FABRICATED_EMPTY_DAY_REPLY,
			hasGroundingActionResult: false,
			trackedWorkContexts: ["tasks"],
		});
		expect(bounced.verdict).toBe("bounce");
		if (bounced.verdict !== "bounce") throw new Error("expected bounce");
		expect(bounced.kind).toBe("empty_tracked_state");
		expect(replyClaimsEmptyTrackedWorkState(bounced.fallbackReply)).toBe(false);
		// No tasks surface registered: "I don't have your list" is an honest
		// capability statement, not a skipped read.
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_EMPTY_DAY_REPLY,
				hasGroundingActionResult: false,
				trackedWorkContexts: [],
			}),
		).toEqual({ verdict: "allow" });
	});

	it("allows a genuinely-empty grounded read and plain answers", () => {
		expect(
			evaluatePlannedReplyEgress({
				reply: "Nothing was recorded this morning — your list is clear.",
				hasGroundingActionResult: true,
				trackedWorkContexts: ["tasks"],
			}),
		).toEqual({ verdict: "allow" });
		expect(
			evaluatePlannedReplyEgress({
				reply: "I haven't set the reminder yet — want me to?",
				hasGroundingActionResult: false,
				trackedWorkContexts: ["tasks"],
			}),
		).toEqual({ verdict: "allow" });
	});

	it("counts only successful non-control tool results as grounding", () => {
		const successfulTool: ActionResult = {
			success: true,
			data: { actionName: "OWNER_REMINDERS" },
		};
		const failedTool: ActionResult = {
			success: false,
			data: { actionName: "OWNER_REMINDERS" },
		};
		const executedReply: ActionResult = {
			success: true,
			data: { actionName: "REPLY" },
		};
		expect(plannedReplyHasGroundingActionResult([successfulTool])).toBe(true);
		expect(plannedReplyHasGroundingActionResult([failedTool])).toBe(false);
		// An executed REPLY re-composes prose; it performs no side effect and
		// reads no state, so it cannot ground a completion or empty-state claim.
		expect(plannedReplyHasGroundingActionResult([executedReply])).toBe(false);
		expect(plannedReplyHasGroundingActionResult([])).toBe(false);
	});
});

describe("tasks context recap/status routing vocabulary", () => {
	// #17059 variant B root cause: the compact DM Stage-1 catalog renders
	// descriptionCompressed ONLY, and the old compressed tasks line carried no
	// recap/status vocabulary — a "recap my day" ask had nothing to route on
	// and fell to contexts=["simple"].
	it("keeps recap/status/summary vocabulary in the COMPRESSED tasks line the DM catalog renders", () => {
		const compact = formatAvailableContextsForPrompt(
			getDefaultContextDefinitions(),
			{ compact: true },
		);
		const tasksLine = compact
			.split("\n")
			.find((line) => line.startsWith("- tasks"));
		expect(tasksLine).toBeDefined();
		expect(tasksLine).toMatch(/recap\/status\/summary/i);
		expect(tasksLine).toMatch(/recap my day/i);
		expect(tasksLine).toMatch(/what's left today/i);
	});

	it("keeps recap examples in the full tasks description", () => {
		const full = formatAvailableContextsForPrompt(
			getDefaultContextDefinitions(),
		);
		const tasksLine = full
			.split("\n")
			.find((line) => line.startsWith("- tasks"));
		expect(tasksLine).toBeDefined();
		expect(tasksLine).toMatch(/recap my day/i);
		expect(tasksLine).toMatch(/what did I get done today/i);
	});
});
