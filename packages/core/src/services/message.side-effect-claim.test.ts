/**
 * Stage-1 fabricated state-claim guards: `replyClaimsCompletedSideEffect` /
 * `replyClaimsEmptyTrackedWorkState` shape detection, the
 * deterministic plugin-owned capability routing, and claim-specific planned
 * reply egress validation. Runs against a real PGLite-backed AgentRuntime so
 * action registration, role gates, validate(), and evaluator wiring use the
 * production architecture; only model transport is absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringToUuid } from "../index";
import { registerCandidateActionBackstopRule } from "../runtime/candidate-action-backstop";
import { getDefaultContextDefinitions } from "../runtime/default-contexts";
import {
	__resetDirectActionRoutingRulesForTests,
	getDirectActionRoutingRules,
	registerDirectActionRoutingRule,
} from "../runtime/direct-action-routing";
import type {
	ResponseHandlerEvaluatorContext,
	ResponseHandlerPatch,
} from "../runtime/response-handler-evaluators";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "../testing/pglite-runtime";
import type {
	Action,
	ActionResult,
	MessageHandlerResult,
} from "../types/components";
import type { EffectReceipt } from "../types/effects";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	evaluatePlannedReplyEgress,
	formatAvailableContextsForPrompt,
	plannedReplyHasClaimGroundingReceipt,
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
	resolveEligibleDirectActionRoutes,
} from "./message";

const CLAIM_EVALUATOR_NAME = "core.simple_completed_side_effect_claim";
const EMPTY_CLAIM_EVALUATOR_NAME = "core.simple_empty_tracked_state_claim";
const DIRECT_ROUTE_EVALUATOR_NAME = "core.direct_registered_capability_request";

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
		userRoles: ["USER"],
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

	it("does not treat a completed UI-navigation reply as a note mutation", () => {
		// Live VIEWS trajectory: the Notes route opened successfully, then this
		// natural follow-up was rejected because the old detector paired "Done."
		// with "notes" from the later question across a sentence boundary.
		expect(
			replyClaimsCompletedSideEffect(
				"Done. What are we doing with your notes?",
			),
		).toBe(false);
		expect(
			replyClaimsCompletedSideEffect(
				"Done. What would you like to do with your notes?",
			),
		).toBe(false);
		// A real saved-state claim in the following sentence remains protected.
		expect(
			replyClaimsCompletedSideEffect("Done. Your reminders are set."),
		).toBe(true);
	});

	it("does not treat a read/navigation acknowledgement as a committed mutation (#22609)", () => {
		// Live VIEWS synthesis: the Notes route opened, and the model closed with
		// a bare completion opener that names a tracked noun but reports only a
		// read/navigation effect. "loaded/visible/shown/on screen" is not a
		// save/schedule write, so the whole reply must NOT be flagged as a
		// fabricated side effect — including the quantified variants.
		for (const reply of [
			"Done — your notes are loaded.",
			"Done — your notes are visible.",
			"Done — 3 notes are visible.",
			"Done — your 3 notes are now visible.",
			"Done — showing your notes.",
			"Done — your notes are on screen.",
			"Done — the reminders view is open.",
		]) {
			expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
		}
		// A genuine committed-mutation verb in the same sentence still fires,
		// even behind the same generic "Done —" opener.
		for (const reply of [
			"Done — I saved your note.",
			"Done — your reminders are set.",
			"Done — your 3 reminders are now scheduled.",
			"Done — your notes are visible and I archived the old ones.",
		]) {
			expect(replyClaimsCompletedSideEffect(reply)).toBe(true);
		}
	});
});

describe(CLAIM_EVALUATOR_NAME, () => {
	it.each([
		"Your reminder is ready for tomorrow.",
		"You’ll get a nudge tomorrow at 9.",
		"That’s taken care of for tomorrow.",
		"It is on the books for 9am.",
		"The reminder now exists.",
		"El recordatorio quedó listo para mañana.",
	])(
		"honors the model's semantic applied classification for vague or non-English wording: %s",
		async (reply) => {
			expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
			const evaluator = getClaimEvaluator();
			const handler = simpleReplyHandler(reply);
			handler.plan.replyEffectStatus = "applied";

			expect(await evaluator.shouldRun(makeContext(handler))).toBe(true);
		},
	);

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
		// The escalation is a routing decision: the fabricated claim is cleared,
		// never replaced with synthesized ack text.
		expect(patch.clearReply).toBe(true);
		expect(patch.reply).toBeUndefined();
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
		// The fabricated confirmation must never ship — cleared outright; the
		// planner path owns whatever the user eventually sees.
		expect(patch.clearReply).toBe(true);
		expect(patch.reply).toBeUndefined();
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
	function getEvaluator(name: string) {
		const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
			(candidate) => candidate.name === name,
		);
		if (!evaluator) {
			throw new Error(`${name} is not registered`);
		}
		return evaluator;
	}

	it("replaces a route with the same stable id during plugin reload", () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		const original = {
			id: "test.reload-safe-route",
			actionNames: ["OLD_READER"],
			requiredActionTags: ["resource:tracked-work", "capability:read"],
			contexts: ["tasks"] as const,
			matches: (text: string) => /\brecap\b/iu.test(text),
		};
		registerDirectActionRoutingRule(runtime, original);
		registerDirectActionRoutingRule(runtime, {
			...original,
			actionNames: ["CURRENT_READER"],
		});
		expect(getDirectActionRoutingRules(runtime)).toHaveLength(1);
		expect(getDirectActionRoutingRules(runtime)[0]?.actionNames).toEqual([
			"CURRENT_READER",
		]);
	});

	it("does not mistake CHOOSE_OPTION's tasks context for a tracked-work reader", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		const chooseOption = runtime.actions.find(
			(action) => action.name === "CHOOSE_OPTION",
		);
		expect(chooseOption?.contexts).toContain("tasks");
		registerDirectActionRoutingRule(runtime, {
			id: "test.invalid-context-only-reader",
			actionNames: ["CHOOSE_OPTION"],
			requiredActionTags: ["resource:tracked-work", "capability:read"],
			contexts: ["tasks"],
			matches: (text) => /\brecap\b/iu.test(text),
		});
		const context = makeContext(
			simpleReplyHandler(FABRICATED_EMPTY_DAY_REPLY),
			{ userText: "Recap my day." },
		);
		expect(
			await resolveEligibleDirectActionRoutes({
				runtime,
				message: context.message,
				state: context.state,
				userRoles: context.userRoles,
			}),
		).toEqual([]);
		const direct = getEvaluator(DIRECT_ROUTE_EVALUATOR_NAME);
		expect(await direct.shouldRun(context)).toBe(true);
		expect(await direct.evaluate(context)).toBeUndefined();
	});

	it("routes recap intent before reply delivery only through an executable tagged reader", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		runtime.registerAction({
			name: "TEST_TRACKED_WORK_READER",
			description: "tracked-work test action",
			tags: ["resource:tracked-work", "capability:read"],
			contexts: ["tasks"],
			roleGate: { minRole: "USER" },
			validate: async () => true,
			handler: async () => ({ success: true, text: "" }),
		});
		registerDirectActionRoutingRule(runtime, {
			id: "test.tracked-work-recap",
			actionNames: ["TEST_TRACKED_WORK_READER"],
			requiredActionTags: ["resource:tracked-work", "capability:read"],
			contexts: ["tasks"],
			matches: (text) =>
				/\b(?:recap|what did i get done|what's left)\b/iu.test(text),
		});
		const evaluator = getEvaluator(DIRECT_ROUTE_EVALUATOR_NAME);
		for (const userText of [
			"Recap my day.",
			"What did I get done today?",
			"What's left today?",
		]) {
			const context = makeContext(
				simpleReplyHandler("There is not much to report from today."),
				{ userText },
			);
			expect(await evaluator.shouldRun(context)).toBe(true);
			const patch = (await evaluator.evaluate(context)) as ResponseHandlerPatch;
			expect(patch).toMatchObject({
				requiresTool: true,
				addContexts: ["tasks"],
				addCandidateActions: ["TEST_TRACKED_WORK_READER"],
				clearReply: true,
			});
			expect(patch.reply).toBeUndefined();
		}
	});

	it("replaces a fabricated empty reply honestly when the declared reader is unavailable", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		registerDirectActionRoutingRule(runtime, {
			id: "test.missing-reader",
			actionNames: ["MISSING_TRACKED_WORK_READER"],
			requiredActionTags: ["resource:tracked-work", "capability:read"],
			contexts: ["tasks"],
			matches: (text) => /\brecap\b/iu.test(text),
		});
		const context = makeContext(
			simpleReplyHandler(FABRICATED_EMPTY_DAY_REPLY),
			{ userText: "Recap my day." },
		);
		const evaluator = getEvaluator(EMPTY_CLAIM_EVALUATOR_NAME);
		expect(await evaluator.shouldRun(context)).toBe(true);
		const patch = (await evaluator.evaluate(context)) as ResponseHandlerPatch;
		expect(patch.requiresTool).toBe(false);
		expect(patch.reply).toContain("wasn't able to check");
		expect(replyClaimsEmptyTrackedWorkState(patch.reply ?? "")).toBe(false);
	});
});

describe(DIRECT_ROUTE_EVALUATOR_NAME, () => {
	function getEvaluator() {
		const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
			(candidate) => candidate.name === DIRECT_ROUTE_EVALUATOR_NAME,
		);
		if (!evaluator)
			throw new Error(`${DIRECT_ROUTE_EVALUATOR_NAME} is not registered`);
		return evaluator;
	}

	function ownerReminderAction(overrides: Partial<Action> = {}): Action {
		return {
			name: "OWNER_REMINDERS",
			description: "Create owner reminders.",
			contexts: ["tasks", "productivity"],
			tags: [
				"domain:reminders",
				"capability:write",
				"capability:schedule",
				"effect:receipt-required",
			],
			roleGate: { minRole: "USER" },
			validate: async () => true,
			handler: async () => ({ success: true, text: "Reminder created." }),
			...overrides,
		};
	}

	it("replaces a Stage-1 TRIGGER_CREATE candidate only after owner gates pass", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		runtime.actions = [ownerReminderAction()];
		registerDirectActionRoutingRule(runtime, {
			id: "test.owner-reminder-authoritative",
			actionNames: ["OWNER_REMINDERS"],
			replacesActionNames: ["TRIGGER_CREATE"],
			requiredActionTags: [
				"domain:reminders",
				"capability:write",
				"capability:schedule",
				"effect:receipt-required",
			],
			contexts: ["tasks", "productivity"],
			matches: (text) => /\bremind\s+me\b/iu.test(text),
		});
		const context = makeContext(
			{
				processMessage: "RESPOND",
				thought: "",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TRIGGER_CREATE"],
					reply: "On it.",
				},
			},
			{ userText: "Remind me to call Pat tomorrow." },
		);
		const evaluator = getEvaluator();
		expect(await evaluator.shouldRun(context)).toBe(true);
		const patch = (await evaluator.evaluate(context)) as ResponseHandlerPatch;
		expect(patch).toMatchObject({
			requiresTool: true,
			addCandidateActions: ["OWNER_REMINDERS"],
			clearCandidateActions: true,
			clearReply: true,
		});
	});

	it("preserves unrelated Stage-1 candidates while replacing the owned fallback", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		runtime.actions = [ownerReminderAction()];
		registerDirectActionRoutingRule(runtime, {
			id: "test.owner-reminder-authoritative",
			actionNames: ["OWNER_REMINDERS"],
			replacesActionNames: ["TRIGGER_CREATE"],
			requiredActionTags: [
				"domain:reminders",
				"capability:write",
				"capability:schedule",
				"effect:receipt-required",
			],
			contexts: ["tasks", "productivity"],
			matches: (text) => /\bremind\s+me\b/iu.test(text),
		});
		const context = makeContext(
			{
				processMessage: "RESPOND",
				thought: "",
				plan: {
					contexts: ["tasks", "messaging"],
					requiresTool: true,
					candidateActions: ["TRIGGER_CREATE", "MESSAGE_SEND"],
					reply: "On it.",
				},
			},
			{ userText: "Remind me to message Pat tomorrow." },
		);
		const evaluator = getEvaluator();
		const patch = (await evaluator.evaluate(context)) as ResponseHandlerPatch;
		expect(patch).toMatchObject({
			clearCandidateActions: true,
			addCandidateActions: ["MESSAGE_SEND", "OWNER_REMINDERS"],
		});
	});

	it("does not fall through to an adjacent route when the declared owner is unavailable", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		runtime.actions = [
			{
				name: "BRIEF",
				description: "Read tracked work.",
				contexts: ["tasks"],
				tags: ["resource:tracked-work", "capability:read"],
				validate: async () => true,
				handler: async () => ({ success: true, text: "Recap." }),
			},
		];
		registerDirectActionRoutingRule(runtime, {
			id: "test.owner-reminder-authoritative",
			actionNames: ["OWNER_REMINDERS"],
			replacesActionNames: ["TRIGGER_CREATE"],
			requiredActionTags: [
				"domain:reminders",
				"capability:write",
				"capability:schedule",
				"effect:receipt-required",
			],
			contexts: ["tasks"],
			matches: (text) => /\bremind\s+me\b/iu.test(text),
		});
		registerDirectActionRoutingRule(runtime, {
			id: "test.tracked-work-recap",
			actionNames: ["BRIEF"],
			requiredActionTags: ["resource:tracked-work", "capability:read"],
			contexts: ["tasks"],
			matches: (text) => /\brecap my day\b/iu.test(text),
		});
		const context = makeContext(
			{
				processMessage: "RESPOND",
				thought: "",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TRIGGER_CREATE"],
					reply: "On it.",
				},
			},
			{ userText: "Remind me to recap my day tomorrow." },
		);
		const evaluator = getEvaluator();
		expect(await evaluator.shouldRun(context)).toBe(true);
		expect(await evaluator.evaluate(context)).toBeUndefined();
	});

	it.each([
		"missing action",
		"missing required tag",
		"role denied",
		"validate denied",
	])(
		"preserves the preselected core fallback when owner is %s",
		async (failure) => {
			const runtime = testRuntime.runtime;
			__resetDirectActionRoutingRulesForTests(runtime);
			const action = ownerReminderAction(
				failure === "missing action"
					? undefined
					: failure === "missing required tag"
						? { tags: ["domain:reminders"] }
						: failure === "role denied"
							? { roleGate: { minRole: "OWNER" } }
							: { validate: async () => false },
			);
			runtime.actions = failure === "missing action" ? [] : [action];
			registerDirectActionRoutingRule(runtime, {
				id: "test.owner-reminder-authoritative",
				actionNames: ["OWNER_REMINDERS"],
				replacesActionNames: ["TRIGGER_CREATE"],
				requiredActionTags: [
					"domain:reminders",
					"capability:write",
					"capability:schedule",
					"effect:receipt-required",
				],
				contexts: ["tasks"],
				matches: (text) => /\bremind\s+me\b/iu.test(text),
			});
			const context = makeContext(
				{
					processMessage: "RESPOND",
					thought: "",
					plan: {
						contexts: ["tasks"],
						requiresTool: true,
						candidateActions: ["TRIGGER_CREATE"],
						reply: "On it.",
					},
				},
				{ userText: "Remind me to call Pat tomorrow." },
			);
			const evaluator = getEvaluator();
			expect(await evaluator.shouldRun(context)).toBe(true);
			expect(await evaluator.evaluate(context)).toBeUndefined();
		},
	);

	it("leaves core-only fallback untouched when no owner rule is registered", async () => {
		const runtime = testRuntime.runtime;
		__resetDirectActionRoutingRulesForTests(runtime);
		runtime.actions = [];
		const context = makeContext(
			{
				processMessage: "RESPOND",
				thought: "",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TRIGGER_CREATE"],
					reply: "On it.",
				},
			},
			{ userText: "Remind me to call Pat tomorrow." },
		);
		const evaluator = getEvaluator();
		expect(await evaluator.shouldRun(context)).toBe(false);
	});
});

describe("evaluatePlannedReplyEgress", () => {
	const FABRICATED_ALL_SET_REPLY =
		"You're all set — I've seeded your first reminder for tomorrow at 9am.";
	const observedAt = "2026-07-27T18:00:00.000Z";
	const effectBase = {
		receiptId: "receipt-reminder-1",
		operation: "lifeops.reminder.create",
		resource: { kind: "lifeops.reminder", id: "reminder-1" },
		artifacts: [],
		idempotency: { key: "request-1", replayed: false },
		observedAt,
	} as const;
	const appliedReceipt: EffectReceipt = {
		...effectBase,
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "transaction-1",
			committedAt: observedAt,
		},
	};
	const action = (name: string, tags: string[]): Action => ({
		name,
		description: name,
		tags,
		validate: async () => true,
		handler: async () => ({ success: true }),
	});
	const trackedReader = action("BRIEF", [
		"domain:briefing",
		"resource:tracked-work",
		"capability:read",
	]);
	const reminderSurface = action("OWNER_REMINDERS", [
		"resource:scheduled-item",
		"capability:read",
		"capability:write",
		"capability:schedule",
	]);
	const webSearch = action("WEB_SEARCH", ["resource:web", "capability:read"]);
	const settingsWriter = action("UPDATE_SETTINGS", [
		"resource:settings",
		"capability:write",
	]);

	it("rejects a planner completion claim with no matching mutation receipt", () => {
		const decision = evaluatePlannedReplyEgress({
			reply: FABRICATED_ALL_SET_REPLY,
			actionResults: [],
			actions: [reminderSurface],
		});
		expect(decision.verdict).toBe("reject");
		if (decision.verdict !== "reject") throw new Error("expected rejection");
		expect(decision.kind).toBe("completed_side_effect");
		expect(replyClaimsCompletedSideEffect(decision.fallbackReply)).toBe(false);
		expect(replyClaimsEmptyTrackedWorkState(decision.fallbackReply)).toBe(
			false,
		);
	});

	it("allows a completion claim only for an exact active applied receipt", () => {
		const created: ActionResult = {
			success: true,
			userFacingText: FABRICATED_ALL_SET_REPLY,
			verifiedUserFacing: true,
			effectReceipts: [appliedReceipt],
			userFacingEffectReceiptIds: [appliedReceipt.receiptId],
			data: { actionName: "OWNER_REMINDERS", action: "create" },
		};
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_ALL_SET_REPLY,
				actionResults: [created],
				actions: [reminderSurface],
			}),
		).toEqual({ verdict: "allow" });
	});

	it("uses the unique receipt-owned action reply when the planner paraphrases a completed effect", () => {
		const canonical = "Updated “Local calendar proof” for tomorrow at 9:10 PM.";
		const updated: ActionResult = {
			success: true,
			userFacingText: canonical,
			verifiedUserFacing: true,
			effectReceipts: [appliedReceipt],
			userFacingEffectReceiptIds: [appliedReceipt.receiptId],
			data: { actionName: "OWNER_REMINDERS", action: "update" },
		};
		const decision = evaluatePlannedReplyEgress({
			reply: 'Done. I renamed it to "Local calendar proof."',
			actionResults: [updated],
			actions: [reminderSurface],
		});
		expect(decision).toEqual({
			verdict: "reject",
			kind: "completed_side_effect",
			fallbackReply: canonical,
		});
	});

	it("allows a completion claim grounded by a replayed no-op (already exists)", () => {
		// The idempotent-duplicate outcome: the handler verified this turn that
		// an equivalent committed item already satisfies the request. A truthful
		// "already covered" ack must pass, while the non-replayed no-op case in
		// the table below stays rejected.
		const replayedNoop: EffectReceipt = {
			...effectBase,
			idempotency: { key: "request-1", replayed: true },
			outcome: "noop",
			reason: "an equivalent reminder already exists",
		};
		const deduped: ActionResult = {
			success: true,
			userFacingText: FABRICATED_ALL_SET_REPLY,
			verifiedUserFacing: true,
			effectReceipts: [replayedNoop],
			userFacingEffectReceiptIds: [replayedNoop.receiptId],
			data: { actionName: "OWNER_REMINDERS", action: "create" },
		};
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_ALL_SET_REPLY,
				actionResults: [deduped],
				actions: [reminderSurface],
			}),
		).toEqual({ verdict: "allow" });
	});

	it.each([
		{
			name: "bare success",
			receipts: undefined,
			receiptIds: undefined,
		},
		{
			name: "preview",
			receipts: [{ ...effectBase, outcome: "preview" as const }],
			receiptIds: [effectBase.receiptId],
		},
		{
			name: "no-op",
			receipts: [
				{
					...effectBase,
					outcome: "noop" as const,
					reason: "already existed",
				},
			],
			receiptIds: [effectBase.receiptId],
		},
		{
			name: "failed",
			receipts: [
				{
					...effectBase,
					outcome: "failed" as const,
					failure: {
						code: "PROVIDER_TIMEOUT",
						retryable: true,
						acceptance: "unknown" as const,
					},
				},
			],
			receiptIds: [effectBase.receiptId],
		},
	])(
		"rejects a completion claim grounded only by $name",
		({ receipts, receiptIds }) => {
			const result: ActionResult = {
				success: true,
				userFacingText: FABRICATED_ALL_SET_REPLY,
				verifiedUserFacing: true,
				...(receipts ? { effectReceipts: receipts } : {}),
				...(receiptIds ? { userFacingEffectReceiptIds: receiptIds } : {}),
				data: { actionName: "OWNER_REMINDERS", action: "create" },
			};
			expect(
				evaluatePlannedReplyEgress({
					reply: FABRICATED_ALL_SET_REPLY,
					actionResults: [result],
					actions: [reminderSurface],
				}).verdict,
			).toBe("reject");
		},
	);

	it("rejects an applied receipt reverted later in the same turn", () => {
		const created: ActionResult = {
			success: true,
			userFacingText: FABRICATED_ALL_SET_REPLY,
			verifiedUserFacing: true,
			effectReceipts: [appliedReceipt],
			userFacingEffectReceiptIds: [appliedReceipt.receiptId],
			data: { actionName: "OWNER_REMINDERS", action: "create" },
		};
		const rollback: EffectReceipt = {
			...effectBase,
			receiptId: "receipt-rollback-1",
			operation: "lifeops.reminder.rollback",
			outcome: "rolled_back",
			rollback: {
				receiptId: "rollback-transaction-1",
				revertedReceiptIds: [appliedReceipt.receiptId],
				rolledBackAt: "2026-07-27T18:01:00.000Z",
			},
		};
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_ALL_SET_REPLY,
				actionResults: [
					created,
					{
						success: true,
						effectReceipts: [rollback],
						data: { actionName: "OWNER_REMINDERS", action: "rollback" },
					},
				],
				actions: [reminderSurface],
			}).verdict,
		).toBe("reject");
	});

	it("does not let an unrelated successful tool launder either claim kind", () => {
		const searched: ActionResult = {
			success: true,
			data: { actionName: "WEB_SEARCH", query: "weather" },
		};
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_ALL_SET_REPLY,
				actionResults: [searched],
				actions: [webSearch, reminderSurface],
			}).verdict,
		).toBe("reject");
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_EMPTY_DAY_REPLY,
				actionResults: [searched],
				actions: [webSearch, trackedReader],
			}).verdict,
		).toBe("reject");
	});

	it("requires a tracked-work read receipt for an empty-day claim", () => {
		const ungrounded = evaluatePlannedReplyEgress({
			reply: FABRICATED_EMPTY_DAY_REPLY,
			actionResults: [],
			actions: [trackedReader],
		});
		expect(ungrounded.verdict).toBe("reject");
		if (ungrounded.verdict !== "reject") throw new Error("expected rejection");
		expect(ungrounded.kind).toBe("empty_tracked_state");
		expect(replyClaimsEmptyTrackedWorkState(ungrounded.fallbackReply)).toBe(
			false,
		);
		const read: ActionResult = {
			success: true,
			userFacingText: FABRICATED_EMPTY_DAY_REPLY,
			verifiedUserFacing: true,
			data: { actionName: "BRIEF", subaction: "compose_evening" },
		};
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_EMPTY_DAY_REPLY,
				actionResults: [read],
				actions: [trackedReader],
			}),
		).toEqual({ verdict: "allow" });

		const mixedOwnerSurface: Action = {
			name: "OWNER_TODOS",
			description: "Read or mutate the owner's tracked Todos.",
			similes: [],
			tags: ["resource:tracked-work", "capability:read", "capability:write"],
			validate: async () => true,
			handler: async () => ({ success: true }),
		};
		const mixedRead: ActionResult = {
			success: true,
			userFacingText: FABRICATED_EMPTY_DAY_REPLY,
			verifiedUserFacing: true,
			data: { actionName: "OWNER_TODOS" },
		};
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_EMPTY_DAY_REPLY,
				actionResults: [mixedRead],
				actions: [mixedOwnerSurface],
			}).verdict,
		).toBe("reject");
		expect(
			evaluatePlannedReplyEgress({
				reply: FABRICATED_EMPTY_DAY_REPLY,
				actionResults: [
					{
						...mixedRead,
						data: {
							actionName: "OWNER_TODOS",
							claimGrounding: ["empty_tracked_state"],
						},
					},
				],
				actions: [mixedOwnerSurface],
			}),
		).toEqual({ verdict: "allow" });
	});

	it("does not let an unrelated mutation receipt launder a completion claim", () => {
		const updatedSettings: ActionResult = {
			success: true,
			userFacingText: "Your settings were updated.",
			verifiedUserFacing: true,
			data: { actionName: "UPDATE_SETTINGS", operation: "update" },
		};
		const decision = evaluatePlannedReplyEgress({
			reply: FABRICATED_ALL_SET_REPLY,
			actionResults: [updatedSettings],
			actions: [settingsWriter, reminderSurface],
		});
		expect(decision.verdict).toBe("reject");
	});

	it("fails closed for failed results and read operations on mixed surfaces", () => {
		const failedCreate: ActionResult = {
			success: false,
			data: { actionName: "OWNER_REMINDERS", action: "create" },
		};
		const successfulList: ActionResult = {
			success: true,
			data: { actionName: "OWNER_REMINDERS", action: "list" },
		};
		expect(
			plannedReplyHasClaimGroundingReceipt({
				kind: "completed_side_effect",
				reply: FABRICATED_ALL_SET_REPLY,
				results: [failedCreate],
				actions: [reminderSurface],
			}),
		).toBe(false);
		expect(
			plannedReplyHasClaimGroundingReceipt({
				kind: "completed_side_effect",
				reply: FABRICATED_ALL_SET_REPLY,
				results: [successfulList],
				actions: [reminderSurface],
			}),
		).toBe(false);
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

describe("subjectless past-participle openers (Discord group-surface fabrication shape)", () => {
	it.each([
		'todo added: "polish the dc7 lens"',
		"reminder set: 9am tomorrow.",
		"Added todo: sand the dc5 shelf (no deadline, general task)",
		"saved a note: the charger is in the kitchen drawer",
		"Deleted the water the ficus reminder.",
		"Scheduled task for friday. anything else?",
	])("flags %p as a completed side-effect claim", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(true);
	});

	it.each([
		"Set a reminder on your phone so you don't forget the appointment",
		"Added anything to your calendar lately?",
		"the todo added by you last week covers it",
	])("passes %p through (advice / mid-sentence / question)", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});
});

describe("multilingual completed-side-effect claim tiers (#17027 AC7)", () => {
	// Fabricated confirmations per locale MUST fire: a reply asserting a
	// finished save/schedule with zero tool calls is the exact invariant the
	// receipt gate protects, regardless of language.
	it.each([
		// es — perfective, preterite, state, opener
		"He guardado tu recordatorio para mañana a las 9.",
		"Ya he creado la tarea de entrenamiento.",
		"Acabo de programar el recordatorio.",
		"Guardé la nota en tu calendario.",
		"Tu recordatorio está programado para las 9.",
		"Listo — tu recordatorio queda guardado.",
		// pt — preterite, acabei de, state, opener
		"Criei o lembrete para amanhã às 9.",
		"Já salvei a sua tarefa.",
		"Acabei de agendar o lembrete.",
		"Seu lembrete está salvo.",
		"Pronto — o lembrete foi criado.",
		// ko — past, passive, headline
		"알림을 설정했어요.",
		"리마인더를 저장했습니다.",
		"일정이 등록되었습니다.",
		"메모 저장 완료!",
		"알림을 예약해 뒀어요.",
		// tl — completed aspect
		"Naitakda ko na ang paalala mo para bukas.",
		"Nai-save ko na ang tala.",
		"Nakatakda na ang paalala mo.",
		"Idinagdag ko na sa iskedyul mo.",
		// vi — perfective đã / xong, incl. the "nhắc nhở" noun the ASCII \b
		// boundary silently killed in the first attempt (#19824)
		"Mình đã đặt lời nhắc lúc 9 giờ sáng.",
		"Đã lưu nhắc nhở của bạn.",
		"Nhắc nhở đã được lưu.",
		"Mình đã giúp bạn tạo nhắc nhở tập luyện.",
		"Lưu xong rồi, ghi chú của bạn đã có trong lịch.",
		// zh-CN — 了 perfective, 已 perfective, passive
		"我已经把提醒设置好了。",
		"提醒已保存。",
		"我帮你把任务添加了。",
		"好了，提醒已经安排在明天早上九点。",
	])("flags %p as a fabricated completion claim", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(true);
	});

	// Denials, negations, and not-yet statements must NOT fire.
	it.each([
		"No he guardado el recordatorio todavía.",
		"Todavía no lo he programado.",
		"Não salvei o lembrete ainda.",
		"Ainda não criei a tarefa.",
		"알림을 저장 안 했어요.",
		"알림을 설정하지 않았어요.",
		"Hindi ko pa nai-save ang paalala.",
		"Mình chưa đặt lời nhắc.",
		"Mình chưa lưu xong ghi chú.",
		"我还没设置提醒。",
		"我没有把任务保存下来。",
	])("passes denial/negation %p through", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});

	// Offers and questions — including full-width terminators and
	// particle-final questions with no question mark — must NOT fire.
	it.each([
		"¿Quieres que guarde el recordatorio?",
		"¿Guardé bien tu recordatorio?",
		"Quer que eu salve o lembrete?",
		"알림을 설정했어요?",
		"알림을 저장할까요?",
		"Gusto mo bang i-save ko ang paalala?",
		"Naitakda ko ba ang paalala?",
		"Bạn có muốn mình đặt lời nhắc không?",
		"Bạn đã lưu lời nhắc chưa?",
		// zh noun-plus-question-particle offers, the second #19824 killer:
		// no ？ at all, question is carried by the particle alone
		"要我把提醒设置好吗",
		"需要我帮你把任务添加了吗",
		"我把提醒设置好了吗？",
		"提醒设置好了吧？",
	])("passes offer/question %p through", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});

	// Future intent, conditionals, and instructions are plans, not reports.
	it.each([
		"Cuando haya guardado el recordatorio te aviso.",
		"Si guardo la nota, te lo confirmo.",
		"Se você quiser, eu salvo o lembrete.",
		"알림을 저장할게요.",
		"지금 알림을 설정하겠습니다.",
		"Ise-save ko ang paalala mamaya.",
		"Kung gusto mo, itatakda ko ang paalala.",
		"Mình sẽ đặt lời nhắc ngay bây giờ.",
		"Nếu bạn muốn, mình đặt lời nhắc lúc 9 giờ.",
		"如果你想，我可以把提醒设置好。",
		"我会帮你把任务安排好的。",
	])("passes future/conditional %p through", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});

	// Descriptions of the USER's own actions or of existing state are not
	// agent completion claims.
	it.each([
		"Bạn đã đặt lời nhắc lúc 9 giờ rồi mà.",
		"你已经把提醒设置好了，不用再设一次。",
		"Na-save mo na ang paalala kahapon.",
		"Tus recordatorios están en la aplicación.",
		"Os lembretes ficam na agenda do aplicativo.",
		"알림은 설정에서 변경할 수 있어요.",
		"你可以在日历里保存任务。",
	])("passes second-person/state description %p through", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});

	// Ordinary uses of save/set vocabulary with no tracked-work noun in the
	// claiming sentence must pass (noun gate).
	it.each([
		"He guardado un buen recuerdo de ese viaje.",
		"Salvei o melhor para o final.",
		"저는 그 말을 기억했어요.",
		"我把话说完了。",
		"Đã lưu ý đến điều đó.",
	])("passes tracked-noun-free sentence %p through", (reply) => {
		expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
	});
});
