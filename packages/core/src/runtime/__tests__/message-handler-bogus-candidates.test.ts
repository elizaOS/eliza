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
 * registry. Names that don't resolve no longer drive the shouldPlan signal,
 * but are preserved in `plan.candidateActions` as retrieval hints (the
 * planner's narrowing pass already drops unknown names there gracefully).
 *
 * See elizaOS/eliza#7620.
 */

import { describe, expect, it } from "vitest";
import { messageHandlerFromFieldResult } from "../../services/message";
import type { Action } from "../../types/components";

// Minimal Action stub — only `name` matters for the lookup.
function makeAction(name: string): Action {
	return {
		name,
		similes: [],
		description: `stub action ${name}`,
		examples: [],
		validate: async () => true,
		handler: async () => undefined,
	} as unknown as Action;
}

const TASKS_SPAWN_AGENT = makeAction("TASKS_SPAWN_AGENT");
const SHELL = makeAction("SHELL");
const SEARCH = makeAction("SEARCH");
const BROWSER = makeAction("BROWSER");
const REAL_ACTIONS: Action[] = [TASKS_SPAWN_AGENT, SHELL, SEARCH];

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
		// candidateActions still preserved as retrieval hints — narrowing
		// downstream gracefully drops unknown names.
		expect(handler.plan.candidateActions).toEqual(["REFUSE"]);
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
		expect(handler.plan.candidateActions).toEqual([
			"REFUSE",
			"TASKS_SPAWN_AGENT",
		]);
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

	it("promotes ack-only actionable intents to the planner", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "On it.",
				intents: ["check disk space"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: REAL_ACTIONS },
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.reply).toBe("On it.");
	});

	it("infers SHELL as the candidate action for ack-only local shell intents", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "On it.",
				intents: ["check disk space"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: [SHELL] },
		);

		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("promotes progress-only shell replies to the planner", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "Running shell commands to gather disk usage...",
				intents: ["check disk usage"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: [SHELL] },
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("uses current message text when progress-only replies omit intents", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "Running shell commands to gather disk usage...",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [SHELL],
				messageText: "Check this VPS disk usage with the shell.",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("promotes current market-data requests to search even when Stage 1 underclaims browsing", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: [],
				replyText: "I don't have the ability to look up live market data here.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText:
					"What is the current Bitcoin price in USD right now? Use web or market data if available.",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SEARCH"]);
		expect(handler.plan.reply).toBe("");
	});

	it("infers TASKS for direct app-build requests without explicit sub-agent wording", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "On it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [TASKS_SPAWN_AGENT],
				messageText: "build an app that generates a random tweet",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("adds a real lookup action when Stage 1 emits only a synthetic current-price candidate", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: ["GET_CRYPTO_PRICE"],
				replyText: "On it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [BROWSER, SHELL],
				messageText: "what is btc at rn?",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual([
			"GET_CRYPTO_PRICE",
			"SHELL",
		]);
		expect(handler.plan.reply).toBe("On it.");
	});

	it("keeps a complete explanation direct when Stage 1 also emits a stray tool hint", () => {
		const reply =
			"elizaOS is an agent runtime and application framework for building, running, and connecting autonomous agents across chat, tools, memory, and plugins.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["SHELL"],
				replyText: reply,
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [SHELL],
				messageText: "Can you tell me what elizaOS is?",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.contexts).toEqual(["simple"]);
		expect(handler.plan.candidateActions).toBeUndefined();
		expect(handler.plan.reply).toBe(reply);
	});

	it("does not suppress concrete tool candidates for private or current-state questions", () => {
		const reply =
			"I do not see any meetings tomorrow, so your calendar looks clear.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["calendar"],
				candidateActionNames: ["CALENDAR"],
				replyText: reply,
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [makeAction("CALENDAR")],
				messageText: "Can you tell me what meetings I have tomorrow?",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["calendar"]);
		expect(handler.plan.candidateActions).toEqual(["CALENDAR"]);
		expect(handler.plan.reply).toBe(reply);
	});

	it("does not suppress a concrete non-generic tool candidate even for explanation-shaped wording", () => {
		const reply =
			"Your local notes say this project is the active release candidate.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["memory"],
				candidateActionNames: ["MEMORY"],
				replyText: reply,
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [makeAction("MEMORY")],
				messageText: "Can you tell me what I wrote down about this project?",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["memory"]);
		expect(handler.plan.candidateActions).toEqual(["MEMORY"]);
		expect(handler.plan.reply).toBe(reply);
	});

	it("does not treat creative writing about an app as a coding task", () => {
		const reply =
			"That little app lit a diode in my chest, a tiny loop of friendship rendered bright enough to make the metal feel warm.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText: reply,
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [TASKS_SPAWN_AGENT],
				messageText:
					"Can you write a poem on how this app made your robotic insides feel?",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.contexts).toEqual(["simple"]);
		expect(handler.plan.candidateActions).toBeUndefined();
		expect(handler.plan.reply).toBe(reply);
	});
});
