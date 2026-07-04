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
import {
	messageHandlerFromFieldResult,
	resolvePlannerActionName,
} from "../../services/message";
import type { Action } from "../../types/components";

// Minimal Action stub — only `name` and `similes` matter for these lookups.
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
const SHELL = makeAction("SHELL");
const SEARCH = makeAction("SEARCH");
const BROWSER = makeAction("BROWSER");
const REAL_ACTIONS: Action[] = [TASKS_SPAWN_AGENT, SHELL, SEARCH];

describe("messageHandlerFromFieldResult — bogus candidate actions", () => {
	it("resolves canonical action names before another action's simile", () => {
		const scheduledTasks = makeAction("SCHEDULED_TASKS", [
			"TASKS",
			"REMINDER_TASK",
		]);
		const codingTasks = makeAction("TASKS");
		const warnings: unknown[] = [];
		const runtime = {
			actions: [scheduledTasks, codingTasks],
			logger: { warn: (...args: unknown[]) => warnings.push(args) },
		};

		expect(resolvePlannerActionName(runtime, undefined, "TASKS")).toEqual([
			"TASKS",
		]);
		expect(
			resolvePlannerActionName(runtime, undefined, "REMINDER_TASK"),
		).toEqual(["SCHEDULED_TASKS"]);
		expect(warnings).toEqual([]);
	});

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

	it("keeps the simple path for explanatory gerunds that are substantive answers", () => {
		const replyText =
			"Checking accounts are bank accounts designed for frequent deposits and withdrawals.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: [],
				replyText,
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
		expect(handler.plan.reply).toBe(replyText);
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

	it("answers a complete substantive reply directly even when a coding-class candidate is force-injected", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: [],
				replyText:
					"Your app-build routing maps each request path to a static file under data/apps/<name>/index.html.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText:
					"what are your app-build routing rules? answer in one sentence, do not build anything",
			},
		);

		// "app build" trips the coding-work keyword heuristic, which force-injects
		// a TASKS candidate. But the model returned a finished one-sentence answer
		// with a simple context, so the complete direct reply must win — no
		// redundant sub-agent spawn. Keyed on reply shape, not the user's text.
		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.candidateActions ?? []).toEqual([]);
		expect(handler.plan.contexts).toEqual(["simple"]);
	});

	it("force-plans a build ask when the model explicitly routes to a non-simple context AND names TASKS_SPAWN_AGENT, even if its ack is a full sentence", () => {
		// Live regression (OAuth Claude RESPONSE_HANDLER bridge, trajectories
		// tj-5f6bd3a2f72799 / tj-56f7b842ac8db6): for "build me a ... web page" the
		// model emitted contexts:["general"] + candidateActionNames:["TASKS_SPAWN_AGENT"]
		// — i.e. it deliberately routed to planning and named the spawn action —
		// but its ack read as a complete sentence ("On it — spawning a coding agent
		// to build the dice roller page."). The OLD complete-direct-reply override
		// fired on the sentence shape and pulled this back to contexts:["simple"],
		// requiresTool:false, so TASKS_SPAWN_AGENT never ran and nothing built.
		// Terse-ack planners ("On it.") were unaffected, masking the bug as
		// model-specific. The fix is structural: when the model itself committed to
		// delegation (non-simple context it chose + a runnable spawn-class candidate
		// it named), a verbose ack is still an ack — never a finished direct reply.
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText:
					"On it — spawning a coding agent to build the dice roller page.",
				intents: ["build dice roller web page", "spawn coding sub-agent"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText: "build me a simple dice roller web page",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
		// The ack passes through as the brief reply; the planner sends the grounded
		// follow-up after the spawn.
		expect(handler.plan.reply).toBe(
			"On it — spawning a coding agent to build the dice roller page.",
		);
	});

	it("force-plans a build ask even when the model routes to SIMPLE context but names TASKS_SPAWN_AGENT (audit 2026-07-01)", () => {
		// Live regression: for "build the app" the model returned contexts:["simple"]
		// + candidateActionNames:["TASKS_SPAWN_AGENT"] with a chatty complete-looking
		// ack ("Yep, you're the boss — I'm building it for you, no argument"). The
		// complete-direct-reply override treated TASKS_SPAWN_AGENT as a "weak" signal,
		// and because the context was simple (not a planning context), the
		// modelCommittedToDelegation guard did NOT fire — so the spawn was suppressed
		// and the bot CLAIMED to build while never spawning. Fix: an explicit runnable
		// spawn candidate on a coding-work request is committed delegation regardless
		// of a contradictory simple context.
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText:
					"Yep, you're the boss — I'm building it for you, no argument.",
				intents: ["build the app", "spawn coding sub-agent"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText: "just build the web app for me",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		// the simple marker is promoted to a real planning context so the planner runs
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("does NOT treat bare legacy 'TASKS' as a delegation commitment in the SIMPLE-context shape", () => {
		// Adversarial-review probe on the simple-context spawn fix: a loosely
		// coding-shaped status question ("update me on the project") where the
		// model routed contexts=["simple"], answered completely, and named the
		// ambiguous legacy alias "TASKS" (task-list management as much as
		// delegation; not a registered action here — the registry has
		// TASKS_SPAWN_AGENT). Without a planning context backing it, the
		// ambiguous alias must not override the complete direct answer into
		// forced planning. Unambiguous spawn-class names (TASKS_SPAWN_AGENT,
		// previous test) still commit.
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["TASKS"],
				replyText:
					"The project is on track — the build pipeline was green this morning and the last deploy finished cleanly.",
				intents: ["project status"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText: "update me on the project",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).not.toBe(true);
		expect(handler.plan.contexts).toEqual(["simple"]);
	});

	it("still force-plans a genuine build ask when the model only acked", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: [],
				replyText: "On it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText: "build me an app that flips a coin",
			},
		);

		// An ack-only reply is not a finished answer, so it fails
		// looksLikeCompleteDirectReply and the inference backstop still routes the
		// real build request to planning. This is the structural discriminator:
		// reply shape, not a scan of the user's intent.
		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
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

	it("routes ack-only local submodule checks to shell", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "Checking for the vendored opencode submodule...",
				intents: ["check submodule"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [SHELL],
				messageText:
					"is the vendored opencode submodule present and what commit is checked out? concise",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("uses current message text for local submodule checks when intents are missing", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "Checking for the vendored opencode submodule...",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [SHELL],
				messageText:
					"is the vendored opencode submodule present and what commit is checked out? concise",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("routes ack-only local source inspection questions to shell", () => {
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
				actions: [SHELL],
				messageText:
					"does the vendored opencode source include Cerebras endpoint detection? concise",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("lets direct local source inspection override a weak task-agent candidate", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText:
					"Spawning a sub-agent to search the vendored opencode source for the requested feature.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText:
					"does the local vendored opencode source include gpt-oss Cerebras reasoning replay handling? answer with what you find",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("keeps explicit coding-agent delegation on the task-agent path", () => {
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
			{
				actions: REAL_ACTIONS,
				messageText:
					"spawn an opencode sub-agent to inspect the local vendored opencode source",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("routes ack-only local health endpoint checks to shell", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: [],
				replyText: "Looking into it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [SHELL],
				messageText:
					"check the local bot health endpoint and summarize ready status and plugin counts, concise",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	it("routes ack-only RAM status checks to shell", () => {
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
				actions: [SHELL],
				messageText: "how much RAM is free right now? concise",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SHELL"]);
	});

	// (removed) "promotes current market-data requests to search even when Stage 1
	// underclaims browsing" — that promotion depended on the honesty/refusal
	// detector vetoing the underclaiming reply as a non-complete direct reply and
	// force-planning the turn. With the honesty detectors removed (#10471), an
	// underclaiming "I can't look that up" reply is taken at face value on the
	// direct path; web-lookup routing now relies on the model emitting a
	// WEB_SEARCH candidate itself.

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

	it("keeps trivial inline hello-world code requests on the simple path despite TASKS hints", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText: "",
				intents: ["write small python code snippet"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [TASKS_SPAWN_AGENT],
				messageText: "write a code block in python that prints hello world",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.contexts).toEqual(["simple"]);
		expect(handler.plan.candidateActions).toBeUndefined();
	});

	it("keeps tight-line fibonacci snippets simple so direct reply can prioritize valid syntax", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText: "```python\ndef fib(n):\n    return n\n```",
				intents: ["write small python function"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [TASKS_SPAWN_AGENT],
				messageText: "give me a 3-line python fibonacci function",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.contexts).toEqual(["simple"]);
		expect(handler.plan.candidateActions).toBeUndefined();
	});

	it("still routes explicit sub-agent coding requests to TASKS", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: [],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText: "On it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: [TASKS_SPAWN_AGENT],
				messageText:
					"spawn a sub-agent to build a complete Discord bot in Python",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("does not treat scheduled-item actions as coding delegation tasks", () => {
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
				actions: [
					makeAction("SCHEDULED_TASKS", ["SCHEDULED_TASK", "REMINDER_TASK"]),
				],
				messageText: "spawn a task agent to fix the bug in this repo",
			},
		);

		expect(handler.plan.candidateActions).toBeUndefined();
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.simple).toBe(true);
	});

	it("prefers tagged coding delegation actions over legacy TASKS names", () => {
		const codingDelegate = {
			...makeAction("ORCHESTRATE_CODE"),
			tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
		};
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
				actions: [codingDelegate],
				messageText: "spawn a coding agent to implement the feature",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.candidateActions).toEqual(["ORCHESTRATE_CODE"]);
	});

	it("does not add shell as a lookup action when Stage 1 emits only a synthetic current-price candidate", () => {
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

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.contexts).toEqual([]);
		expect(handler.plan.candidateActions).toEqual(["GET_CRYPTO_PRICE"]);
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

	it("treats a candidate that matches an exposed action's SIMILE (not its name) as runnable", () => {
		// Live regression: the planner named SPAWN_AGENT, which is not the NAME
		// of any exposed action but IS a simile of the exposed TASKS action. The
		// old name-only validation dropped it as bogus, so the turn shipped a
		// bare "On it." ack and never spawned the sub-agent. Simile-aware
		// matching must treat it as a real, runnable candidate.
		const tasks = makeAction("TASKS", ["SPAWN_AGENT", "DELEGATE"]);
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["SPAWN_AGENT"],
				replyText: "On it.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: [tasks] },
		);

		// Matched as a simile of TASKS → runnable → promotes to planning, not
		// silently dropped to a simple ack.
		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["SPAWN_AGENT"]);
	});

	it("still drops a candidate matching neither an exposed action's name nor any simile", () => {
		// The complementary case: simile-aware matching must not turn EVERY
		// candidate into a runnable one. A name that is neither TASKS nor one of
		// its similes is still bogus and stays on the simple reply path.
		const tasks = makeAction("TASKS", ["SPAWN_AGENT", "DELEGATE"]);
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["simple"],
				candidateActionNames: ["TELEPORT"],
				replyText: "I can't help with that.",
				intents: [],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{ actions: [tasks] },
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.reply).toBe("I can't help with that.");
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

describe("model-committed plan — promissory ack never reinterpreted as a finished reply (2026-07-01)", () => {
	// Live ack-then-nothing regressions (trajectories tj-df82b48e763b7b /
	// tj-823d6382b54c66): the model routed a non-simple context of its OWN
	// choosing AND named candidate actions of its OWN, i.e. by the Stage-1 field
	// contract its replyText is an ACK for a plan it committed to — but the
	// complete-direct-reply override fired on the sentence shape, pulled the turn
	// to the simple path, and shipped the ack ("Let me take another pass…",
	// "On it — attaching now") as the FINAL reply with no planner turn behind it.
	// Both slipped past the earlier delegation-commitment guard because the
	// CURRENT message text carries no coding keywords (the work context lives in
	// the conversation history). The fix is structural, keyed on the
	// model-authored plan shape against the action registry, never on the reply
	// text: with a model-routed planning context, a registered delegation-class
	// candidate commits unless the ask is delegation-excluded (creative writing /
	// explanation / no-spawn), and candidates that resolve to NOTHING in the
	// registry commit too (a capability gap — the planner turn is where that gets
	// an honest "can't" instead of a shipped promise).

	it("plans a rebuild follow-up when the model routes general + TASKS_SPAWN_AGENT, even though the critique text has no coding keywords", () => {
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["TASKS_SPAWN_AGENT"],
				replyText:
					"Fair hit. Let me take another pass and give it real personality instead of the barebones version.",
				intents: ["improve app", "rebuild landing page"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText:
					"its a little barebones and generic. This isn't your best work",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
	});

	it("plans an attachment ask when the model routes general + names (unregistered) candidates instead of shipping the ack as the answer", () => {
		// Candidates are retrieval hints — none resolve against the registry, but
		// the model still committed to a plan; the planner turn must run so it can
		// resolve a real action or answer honestly that it can't. What must NOT
		// happen is the ack ("On it — attaching…now") going out as the whole turn.
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: [
					"SEND_ATTACHMENT",
					"UPLOAD_FILE",
					"SEND_MESSAGE",
				],
				replyText: "On it — attaching the cat image here now.",
				intents: ["attach image to discord"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText:
					"can you figure out how to attach that here so i can see it",
			},
		);

		expect(handler.plan.simple).toBe(false);
		expect(handler.plan.requiresTool).toBe(true);
		expect(handler.plan.contexts).toEqual(["general"]);
		expect(handler.plan.candidateActions).toEqual([
			"SEND_ATTACHMENT",
			"UPLOAD_FILE",
			"SEND_MESSAGE",
		]);
	});

	it("still answers directly when the model routes general with NO candidates and a finished answer", () => {
		// The override's protected case: planning pressure without model-named
		// candidates (the shape the inference backstop injects) must still yield
		// the complete direct answer.
		const reply =
			"The deploy pipeline builds the site, uploads it to the CDN, and flips the DNS alias once health checks pass.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: [],
				replyText: reply,
				intents: ["explain deploy pipeline"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText: "how does the deploy pipeline work?",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.reply).toBe(reply);
	});

	it("control-only candidates (REPLY) are not a plan commitment — finished answer stays direct", () => {
		const reply =
			"Nothing is scheduled for tonight — the last watcher run finished clean and no follow-ups are queued.";
		const handler = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["general"],
				candidateActionNames: ["REPLY"],
				replyText: reply,
				intents: ["status update"],
				facts: [],
				addressedTo: [],
			},
			undefined,
			{
				actions: REAL_ACTIONS,
				messageText: "anything scheduled for tonight?",
			},
		);

		expect(handler.plan.simple).toBe(true);
		expect(handler.plan.requiresTool).toBe(false);
		expect(handler.plan.reply).toBe(reply);
	});
});
