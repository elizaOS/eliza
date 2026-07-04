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
});
