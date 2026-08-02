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
