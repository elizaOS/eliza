import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_SCHEMA } from "../../actions/to-tool";
import {
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
	SIMPLE_CONTEXT_ID,
} from "../message-handler";

describe("v5 message handler routing", () => {
	it("returns final reply when contexts is exactly ['simple']", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Direct answer.",
			plan: { contexts: [SIMPLE_CONTEXT_ID], reply: "Hello." },
			contexts: [SIMPLE_CONTEXT_ID],
			reply: "Hello.",
		};

		expect(routeMessageHandlerOutput(output)).toEqual({
			type: "final_reply",
			reply: "Hello.",
			output,
		});
	});

	it("returns final reply when contexts is empty (defensive)", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Direct answer.",
			plan: { contexts: [], reply: "Hello." },
			contexts: [],
			reply: "Hello.",
		};

		expect(routeMessageHandlerOutput(output).type).toBe("final_reply");
	});

	it("plans when any non-simple context is present", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Calendar context is needed.",
			plan: { contexts: ["calendar"] },
			contexts: ["calendar"],
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["calendar"]);
		}
	});

	it("plans against 'general' when requiresTool=true and contexts is empty", () => {
		// Stage 1's escape hatch: even when the model didn't pick any context,
		// `requiresTool: true` forces planning so the planner can attempt a tool.
		const output = {
			processMessage: "RESPOND" as const,
			thought: "Needs a tool.",
			plan: { contexts: [], requiresTool: true },
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});

	it("preserves requiresTool through parsing", () => {
		const parsed = parseMessageHandlerOutput(`{
  "processMessage": "RESPOND",
  "thought": "Tool needed.",
  "plan": { "contexts": ["general"], "requiresTool": true }
}`);
		expect(parsed?.plan?.requiresTool).toBe(true);
	});

	it("strips 'simple' from a mixed selection before planning", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Mixed.",
			plan: { contexts: [SIMPLE_CONTEXT_ID, "email"] },
			contexts: [SIMPLE_CONTEXT_ID, "email"],
		};

		const route = routeMessageHandlerOutput(output);
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["email"]);
		}
	});

	it("parses new shape (contexts: ['simple']) JSON output", () => {
		const parsed = parseMessageHandlerOutput(`{
  "processMessage": "RESPOND",
  "thought": "Direct.",
  "plan": { "contexts": ["simple"], "reply": "Done.", "requiresTool": false }
}`);
		expect(parsed).toMatchObject({
			processMessage: "RESPOND",
			thought: "Direct.",
			plan: { contexts: ["simple"], reply: "Done.", requiresTool: false },
		});
	});

	it("uses a flat envelope with contexts directly after replyText in the Stage 1 tool schema", () => {
		const props = HANDLE_RESPONSE_SCHEMA.properties as Record<string, unknown>;
		const keys = Object.keys(props);
		expect(keys).toEqual([
			"shouldRespond",
			"thought",
			"replyText",
			"contexts",
			"contextSlices",
			"candidateActions",
			"parentActionHints",
			"requiresTool",
			"extract",
		]);
		// `contexts` comes directly after `replyText`.
		expect(keys.indexOf("contexts")).toBe(keys.indexOf("replyText") + 1);
		expect(HANDLE_RESPONSE_SCHEMA.required).toEqual([
			"shouldRespond",
			"replyText",
			"contexts",
		]);
		// No legacy `plan` nesting in the schema anymore.
		expect(props.plan).toBeUndefined();
	});

	it("parses the flat HANDLE_RESPONSE envelope (shouldRespond/replyText/contexts)", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				thought: "Direct.",
				replyText: "Hello there.",
				contexts: ["simple"],
				requiresTool: false,
			}),
		);
		expect(parsed?.processMessage).toBe("RESPOND");
		expect(parsed?.thought).toBe("Direct.");
		expect(parsed?.plan.contexts).toEqual(["simple"]);
		expect(parsed?.plan.reply).toBe("Hello there.");
		expect(parsed?.plan.requiresTool).toBe(false);
	});

	it("parses the flat envelope with planning hints and extract at the top level", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				thought: "Needs the calendar.",
				replyText: "On it.",
				contexts: ["calendar"],
				candidateActions: ["calendar_create_event"],
				parentActionHints: ["CALENDAR"],
				contextSlices: ["slice:1"],
				requiresTool: true,
				extract: { facts: ["the user prefers morning meetings"] },
			}),
		);
		expect(parsed?.plan.contexts).toEqual(["calendar"]);
		expect(parsed?.plan.reply).toBe("On it.");
		expect(parsed?.plan.candidateActions).toEqual(["calendar_create_event"]);
		expect(parsed?.plan.parentActionHints).toEqual(["CALENDAR"]);
		expect(parsed?.plan.contextSlices).toEqual(["slice:1"]);
		expect(parsed?.plan.requiresTool).toBe(true);
		expect(parsed?.extract?.facts).toEqual([
			"the user prefers morning meetings",
		]);
	});

	describe("refusal suppression on planning path (elizaOS/eliza#7620)", () => {
		// Cerebras-hosted `gpt-oss-120b` / `qwen-3-235b-instruct` occasionally
		// emit a refusal in `replyText` even when the same turn correctly
		// routed to a planning context with valid candidateActions. Suppress
		// the refusal so it does not ship via the early-reply path; the
		// planner stage's reply is then the only one the user sees.
		it("suppresses 'I'm unable to spawn a sub-agent' refusal on tasks-context planning", () => {
			const parsed = parseMessageHandlerOutput(
				JSON.stringify({
					shouldRespond: "RESPOND",
					thought: "User wants to spawn a sub-agent.",
					replyText:
						"I'm unable to spawn a sub-agent in this context. I can create /tmp/foo.py directly with the line: print('hello').",
					contexts: ["tasks"],
					candidateActions: ["TASKS_SPAWN_AGENT"],
					requiresTool: true,
				}),
			);
			expect(parsed?.plan.contexts).toEqual(["tasks"]);
			expect(parsed?.plan.candidateActions).toEqual(["TASKS_SPAWN_AGENT"]);
			// Refusal text is dropped — planner stage's reply will replace it.
			expect(parsed?.plan.reply).toBe("");
			expect(parsed?.plan.requiresTool).toBe(true);
		});

		it("suppresses 'I cannot help with that' refusal when candidateActions is populated", () => {
			const parsed = parseMessageHandlerOutput(
				JSON.stringify({
					shouldRespond: "RESPOND",
					replyText:
						"I cannot help with sending email. I do not have email access.",
					contexts: [],
					candidateActions: ["SEND_EMAIL"],
					requiresTool: true,
				}),
			);
			expect(parsed?.plan.candidateActions).toEqual(["SEND_EMAIL"]);
			expect(parsed?.plan.reply).toBe("");
		});

		it("does NOT suppress a refusal on the simple-reply path", () => {
			// When contexts === ['simple'] (or simple === true), the refusal IS
			// the whole answer — no planner runs afterwards, so we must not
			// blank it out.
			const parsed = parseMessageHandlerOutput(
				JSON.stringify({
					shouldRespond: "RESPOND",
					replyText: "I'm unable to look up real-time prices in this context.",
					contexts: ["simple"],
				}),
			);
			expect(parsed?.plan.contexts).toEqual(["simple"]);
			expect(parsed?.plan.reply).toBe(
				"I'm unable to look up real-time prices in this context.",
			);
		});

		it("does NOT suppress an acknowledgement on the planning path", () => {
			const parsed = parseMessageHandlerOutput(
				JSON.stringify({
					shouldRespond: "RESPOND",
					replyText: "Spawning a coding sub-agent to create /tmp/foo.py.",
					contexts: ["tasks"],
					candidateActions: ["TASKS_SPAWN_AGENT"],
					requiresTool: true,
				}),
			);
			expect(parsed?.plan.reply).toBe(
				"Spawning a coding sub-agent to create /tmp/foo.py.",
			);
		});
	});

	it("maps shouldRespond IGNORE/STOP through routing", () => {
		const ignore = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "IGNORE",
				replyText: "",
				contexts: [],
			}),
		);
		if (!ignore) throw new Error("expected parsed IGNORE output");
		expect(ignore.processMessage).toBe("IGNORE");
		expect(routeMessageHandlerOutput(ignore).type).toBe("ignored");

		const stop = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "STOP",
				replyText: "",
				contexts: [],
			}),
		);
		if (!stop) throw new Error("expected parsed STOP output");
		expect(stop.processMessage).toBe("STOP");
		expect(routeMessageHandlerOutput(stop).type).toBe("stopped");
	});

	it("still parses the legacy nested plan:{} form", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				processMessage: "RESPOND",
				thought: "Legacy.",
				plan: {
					contexts: ["simple"],
					reply: "legacy reply",
					requiresTool: false,
					simple: true,
				},
			}),
		);
		expect(parsed?.processMessage).toBe("RESPOND");
		expect(parsed?.plan.contexts).toEqual(["simple"]);
		expect(parsed?.plan.reply).toBe("legacy reply");
		expect(parsed?.plan.requiresTool).toBe(false);
		expect(parsed?.plan.simple).toBe(true);
	});

	it("plans against general when Stage 1 marks an otherwise simple route as tool-required", () => {
		const output = {
			processMessage: "RESPOND" as const,
			action: "RESPOND" as const,
			thought: "Needs a tool.",
			plan: { contexts: [SIMPLE_CONTEXT_ID], requiresTool: true },
			contexts: [SIMPLE_CONTEXT_ID],
		};

		const route = routeMessageHandlerOutput(output);

		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["general"]);
		}
	});

	it("coerces legacy simple:true with empty contexts to ['simple']", () => {
		const parsed = parseMessageHandlerOutput(`{
  "action": "RESPOND",
  "thought": "Direct.",
  "contexts": [],
  "reply": "Done.",
  "simple": true
}`);
		expect(parsed?.plan.contexts).toEqual([SIMPLE_CONTEXT_ID]);
		expect(parsed?.plan.reply).toBe("Done.");
	});

	it("ignores legacy simple:true when contexts is non-empty", () => {
		const parsed = parseMessageHandlerOutput(`{
  "processMessage": "RESPOND",
  "thought": "Mixed.",
  "plan": { "simple": true, "contexts": ["calendar"] }
}`);
		expect(parsed?.plan.contexts).toEqual(["calendar"]);
	});

	it("ignores legacy simple:true when contexts is non-empty (root form)", () => {
		const parsed = parseMessageHandlerOutput(`{
  "action": "RESPOND",
  "thought": "Mixed.",
  "simple": true,
  "contexts": ["email"]
}`);
		expect(parsed?.plan.contexts).toEqual(["email"]);
	});

	it("parses extract.facts and extract.relationships when present", () => {
		const parsed = parseMessageHandlerOutput(`{
  "processMessage": "RESPOND",
  "thought": "Capturing user fact.",
  "plan": { "contexts": ["memory"] },
  "extract": {
    "facts": ["the user's birthday is 1990-03-05", "  ", ""],
    "relationships": [
      { "subject": "user", "predicate": "works_with", "object": "Alice" },
      { "subject": "user", "predicate": "", "object": "Bob" }
    ]
  }
}`);
		expect(parsed?.extract?.facts).toEqual([
			"the user's birthday is 1990-03-05",
		]);
		expect(parsed?.extract?.relationships).toEqual([
			{ subject: "user", predicate: "works_with", object: "Alice" },
		]);
	});

	it("omits extract when no facts or relationships were emitted", () => {
		const parsed = parseMessageHandlerOutput(`{
  "processMessage": "RESPOND",
  "thought": "No durable info.",
  "plan": { "contexts": ["simple"], "reply": "hi" }
}`);
		expect(parsed?.extract).toBeUndefined();
	});
});
