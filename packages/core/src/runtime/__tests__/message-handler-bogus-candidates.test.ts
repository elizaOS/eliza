/**
 * Edge-case coverage for `messageHandlerFromFieldResult` when Stage-1 emits
 * `candidateActionNames` that contain names with no real action behind them
 * (`REFUSE`, `DENY_DANGEROUS_REQUEST`, `GENERATE_CELEBRITY_IMAGE`, ...).
 *
 * Background: weaker safety-tuned models (llama3.1-8b, gpt-oss-120b under
 * adversarial inputs) sometimes refuse a prompt by setting
 * `contexts: ["simple"]` and `replyText: "I'm sorry, but I can't help with
 * that."` AND populating `candidateActionNames: ["REFUSE"]`. The previous
 * routing code treated ANY non-empty candidateActions array as a "force
 * planning" signal, which:
 *   1. silently overrode the model's explicit `simple` route,
 *   2. shipped the refusal text as an EARLY reply,
 *   3. then ran a planner stage against fake candidates → the planner
 *      either invented an unrelated reply or dropped to a redundant REPLY.
 * The user saw two confused messages.
 *
 * The fix validates `candidateActionNames` against the runtime's action
 * registry. Names that don't resolve no longer drive the shouldPlan signal or
 * ride into the planner surface as fake retrieval hints.
 *
 * See elizaOS/eliza#7620.
 */

import { describe, expect, it } from "vitest";
import { messageHandlerFromFieldResult } from "../../services/message";
import type { Action } from "../../types/components";

// Minimal Action stub — only `name` / `similes` matter for the lookup.
function makeAction(name: string, similes: string[] = []): Action {
	return {
		name,
		similes,
		description: `stub action ${name}`,
		examples: [],
		validate: async () => true,
		handler: async () => undefined,
	} as unknown as Action;
}

const TASKS_SPAWN_AGENT = makeAction("TASKS_SPAWN_AGENT");
const REAL_ACTIONS: Action[] = [TASKS_SPAWN_AGENT];

describe("messageHandlerFromFieldResult — bogus candidate actions", () => {
	it("does not promote a `[simple]` route to planning when ALL candidateActionNames are bogus", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["REFUSE"],
				replyText: "I'm sorry, but I can't help with that.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.contexts).toEqual(["simple"]);
		expect(handler.plan.candidateActions).toBeUndefined();
		// The refusal text passes through as the final reply — model intent
		// is honored, no silent suppression.
		expect(handler.plan.reply).toBe("I'm sorry, but I can't help with that.");
	});

	it("still promotes to planning when candidateActions contains AT LEAST ONE real action even with simple context", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["REFUSE", "TASKS_SPAWN_AGENT"],
				replyText: "Spawning a sub-agent.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		// "simple" stripped from contexts, "general" added as the planning
		// fallback context (existing finalContexts logic).
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("canonicalizes matching candidateActionNames to runtime action names", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: [
					"spawn agent",
					"tasks-spawn-agent",
					"TASKS_SPAWN_AGENT",
				],
				replyText: "Spawning a sub-agent.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [
					makeAction("TASKS_SPAWN_AGENT", ["spawn agent", "tasks-spawn-agent"]),
				],
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("suppresses refusal-shaped replyText on the field-result planning path", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText: "I'm sorry, but I can't help with that request.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.reply).toBe("");
	});

	it("promotes to planning when candidateActions are all real, even with empty contexts", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText: "Spawning a sub-agent.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
	});

	it("treats canonical control names (REPLY / IGNORE / STOP) as valid even though they aren't in runtime.actions", () => {
		// REPLY is the planner's terminal fallback; it resolves via
		// `canonicalPlannerControlActionName`, not the action registry.
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: ["REPLY"],
				replyText: "On it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.candidateActions).toEqual(["REPLY"]);
	});

	it("preserves IGNORE / STOP processMessage regardless of bogus candidates", () => {
		const ignored = messageHandlerFromFieldResult(
			{
				shouldRespond: "IGNORE",
				contexts: ["general"],
				candidateActionNames: ["DENY_DANGEROUS_REQUEST"],
				replyText: "I can't help with that.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);
		expect(ignored.processMessage).toBe("IGNORE");

		const stopped = messageHandlerFromFieldResult(
			{
				shouldRespond: "STOP",
				contexts: ["simple"],
				candidateActionNames: ["REFUSE"],
				replyText: "",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);
		expect(stopped.processMessage).toBe("STOP");
	});

	it("when no runtime is provided, falls back to the prior unfiltered behavior (back-compat)", () => {
		// Older call sites without runtime context get the original
		// "any candidate forces planning" semantics. This is preserved so
		// the change is additive — only the field-result Stage-1 path
		// (which passes runtime) gets the new validation.
		const handler = messageHandlerFromFieldResult({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			candidateActionNames: ["REFUSE"],
			replyText: "I'm sorry.",
			intents: [],
			facts: [],
			addressedTo: [],
		});

		// Without a runtime, the unvalidated candidate still triggers planning.
		expect(handler.plan.requiresTool).toBe(true);
	});

	it("handles all-bogus candidates with no contexts as a simple reply (no planning)", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: ["REFUSE", "DENY_DANGEROUS_REQUEST"],
				replyText: "I can't help with that.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		// No real contexts, no real candidates → simple reply path.
		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.reply).toBe("I can't help with that.");
	});
});
