/**
 * Exercises the per-runtime candidate-action backstop rule registry and its
 * effect on planner candidate selection: a genuine scheduled-task candidate is
 * protected while one that only accidentally surfaced on a coding turn is
 * stripped in favor of the coding-delegation action. Deterministic, synthetic
 * runtime — no model.
 */
import { describe, expect, it } from "vitest";
import { messageHandlerFromFieldResult } from "../../services/message";
import type { IAgentRuntime } from "../../types/runtime";
import {
	__resetCandidateActionBackstopRulesForTests,
	type CandidateActionBackstopRule,
	getCandidateActionBackstopRules,
	registerCandidateActionBackstopRule,
} from "../candidate-action-backstop";

const makeRuntime = (): IAgentRuntime => ({}) as unknown as IAgentRuntime;

const schedulingRule: CandidateActionBackstopRule = {
	actionNames: ["SCHEDULED_TASKS", "SCHEDULED_TASKS_CREATE"],
	matches: (text) =>
		/\b(?:remind\s+me|scheduled\s+task|tomorrow)\b/iu.test(text),
};

describe("candidate-action backstop registry", () => {
	it("starts empty and returns registered rules in order", () => {
		const runtime = makeRuntime();
		expect(getCandidateActionBackstopRules(runtime)).toEqual([]);

		const second: CandidateActionBackstopRule = {
			actionNames: ["OTHER"],
			matches: () => false,
		};
		registerCandidateActionBackstopRule(runtime, schedulingRule);
		registerCandidateActionBackstopRule(runtime, second);

		expect(getCandidateActionBackstopRules(runtime)).toEqual([
			schedulingRule,
			second,
		]);

		__resetCandidateActionBackstopRulesForTests(runtime);
		expect(getCandidateActionBackstopRules(runtime)).toEqual([]);
	});

	it("keeps registrations isolated per runtime", () => {
		const a = makeRuntime();
		const b = makeRuntime();
		registerCandidateActionBackstopRule(a, schedulingRule);
		expect(getCandidateActionBackstopRules(a)).toHaveLength(1);
		expect(getCandidateActionBackstopRules(b)).toEqual([]);
	});

	it("drives the coding-delegation backstop selection when threaded into the pipeline", () => {
		const runtime = makeRuntime();
		registerCandidateActionBackstopRule(runtime, schedulingRule);

		const runtimeContext = {
			actions: [
				{
					name: "TASKS",
					tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
				},
				{ name: "SCHEDULED_TASKS_CREATE" },
			],
			candidateBackstopRules: getCandidateActionBackstopRules(runtime),
		};

		// A genuine scheduled-task turn: the rule matches, so its candidate is
		// protected and never rewritten to the coding-delegation action.
		const scheduled = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["tasks"],
				intents: ["create scheduled task"],
				replyText: "I'll schedule that.",
				candidateActionNames: ["SCHEDULED_TASKS_CREATE"],
				facts: [],
				relationships: [],
				addressedTo: [],
			},
			undefined,
			{
				...runtimeContext,
				messageText: "create a scheduled task to fix the app tomorrow",
			},
		);
		expect(scheduled.plan.contexts).not.toContain("code");
		expect(scheduled.plan.candidateActions).toEqual(["SCHEDULED_TASKS_CREATE"]);

		// A coding turn that only accidentally surfaced a scheduled-task
		// candidate: the rule does not match, so the candidate is stripped and
		// the coding-delegation action wins.
		const coding = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["tasks"],
				intents: ["update website"],
				replyText: "On it.",
				candidateActionNames: ["SCHEDULED_TASKS_CREATE"],
				facts: [],
				relationships: [],
				addressedTo: [],
			},
			undefined,
			{
				...runtimeContext,
				messageText: "update the website code, add some fixes",
			},
		);
		expect(coding.plan.contexts).toContain("code");
		expect(coding.plan.candidateActions).toEqual(["TASKS"]);
	});

	it("protects candidates registered under a loosely-cased action name", () => {
		const runtime = makeRuntime();
		registerCandidateActionBackstopRule(runtime, {
			actionNames: ["Scheduled_Tasks_Create"],
			matches: (text) => /\bremind\s+me\b/iu.test(text),
		});

		const runtimeContext = {
			actions: [
				{
					name: "TASKS",
					tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
				},
				{ name: "SCHEDULED_TASKS_CREATE" },
			],
			candidateBackstopRules: getCandidateActionBackstopRules(runtime),
		};

		// The turn reads as coding work, but the rule owns the candidate through
		// canonical identifier normalization and recognizes the request, so the
		// candidate survives instead of being rewritten to TASKS.
		const protectedTurn = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["tasks"],
				intents: ["set reminder"],
				replyText: "Done.",
				candidateActionNames: ["SCHEDULED_TASKS_CREATE"],
				facts: [],
				relationships: [],
				addressedTo: [],
			},
			undefined,
			{
				...runtimeContext,
				messageText: "fix the login bug and remind me tomorrow",
			},
		);
		expect(protectedTurn.plan.candidateActions).toEqual([
			"SCHEDULED_TASKS_CREATE",
		]);
		expect(protectedTurn.plan.contexts).not.toContain("code");
	});

	it("resets only the given runtime's rules", () => {
		const a = makeRuntime();
		const b = makeRuntime();
		registerCandidateActionBackstopRule(a, schedulingRule);
		registerCandidateActionBackstopRule(b, schedulingRule);

		__resetCandidateActionBackstopRulesForTests(a);

		expect(getCandidateActionBackstopRules(a)).toEqual([]);
		expect(getCandidateActionBackstopRules(b)).toEqual([schedulingRule]);
	});

	it("appends duplicate registrations without deduplicating them", () => {
		const runtime = makeRuntime();
		const other: CandidateActionBackstopRule = {
			actionNames: ["OTHER"],
			matches: () => false,
		};

		registerCandidateActionBackstopRule(runtime, schedulingRule);
		registerCandidateActionBackstopRule(runtime, other);
		registerCandidateActionBackstopRule(runtime, schedulingRule);

		expect(getCandidateActionBackstopRules(runtime)).toEqual([
			schedulingRule,
			other,
			schedulingRule,
		]);
	});

	it("consults each rule with the exact current message text", () => {
		const runtime = makeRuntime();
		const consultedWith: string[] = [];
		registerCandidateActionBackstopRule(runtime, {
			actionNames: ["SCHEDULED_TASKS_CREATE"],
			matches: (text) => {
				consultedWith.push(text);
				return false;
			},
		});

		const runtimeContext = {
			actions: [
				{
					name: "TASKS",
					tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
				},
				{ name: "SCHEDULED_TASKS_CREATE" },
			],
			candidateBackstopRules: getCandidateActionBackstopRules(runtime),
		};

		const messageText = "update the website code, add some fixes";
		messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["tasks"],
				intents: ["update website"],
				replyText: "On it.",
				candidateActionNames: ["SCHEDULED_TASKS_CREATE"],
				facts: [],
				relationships: [],
				addressedTo: [],
			},
			undefined,
			{ ...runtimeContext, messageText },
		);

		expect(consultedWith).toEqual([messageText]);
	});
});
