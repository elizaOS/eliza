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

	it("does not parse retired requiresTool from the model envelope", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				thought: "Tool needed.",
				replyText: "",
				contexts: ["general"],
				requiresTool: true,
			}),
		);
		expect(parsed?.plan?.requiresTool).toBeUndefined();
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

	it("parses canonical contexts: ['simple'] flat envelope output", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Done.",
				contexts: ["simple"],
			}),
		);
		expect(parsed).toMatchObject({
			processMessage: "RESPOND",
			thought: "",
			plan: { contexts: ["simple"], reply: "Done." },
		});
	});

	it("uses the canonical response-handler field envelope in the Stage 1 tool schema", () => {
		const props = HANDLE_RESPONSE_SCHEMA.properties as Record<string, unknown>;
		const keys = Object.keys(props);
		expect(keys).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
			"facts",
			"relationships",
			"addressedTo",
			"emotion",
		]);
		expect(HANDLE_RESPONSE_SCHEMA.required).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
			"facts",
			"relationships",
			"addressedTo",
			"emotion",
		]);
		expect(props.plan).toBeUndefined();
		expect(props.contextSlices).toBeUndefined();
		expect(props.candidateActions).toBeUndefined();
		expect(props.parentActionHints).toBeUndefined();
		expect(props.requiresTool).toBeUndefined();
		expect(props.extract).toBeUndefined();
	});

	it("parses the flat HANDLE_RESPONSE envelope (shouldRespond/replyText/contexts)", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "Hello there.",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.processMessage).toBe("RESPOND");
		expect(parsed?.thought).toBe("");
		expect(parsed?.plan.contexts).toEqual(["simple"]);
		expect(parsed?.plan.reply).toBe("Hello there.");
		expect(parsed?.plan.requiresTool).toBeUndefined();
	});

	it("does not pass JSON structural punctuation through as reply text", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "}",
				contexts: ["simple"],
			}),
		);

		expect(parsed?.plan.reply).toBe("");
	});

	it("parses the canonical field envelope with action hints and memory fields", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "On it.",
				contexts: ["calendar"],
				candidateActionNames: ["calendar_create_event"],
				facts: ["the user prefers morning meetings"],
				relationships: [],
				addressedTo: [],
			}),
		);
		expect(parsed?.plan.contexts).toEqual(["calendar"]);
		expect(parsed?.plan.reply).toBe("On it.");
		expect(parsed?.plan.candidateActions).toEqual(["calendar_create_event"]);
		expect(parsed?.plan.parentActionHints).toBeUndefined();
		expect(parsed?.plan.contextSlices).toBeUndefined();
		expect(parsed?.plan.requiresTool).toBeUndefined();
		expect(parsed?.extract?.facts).toEqual([
			"the user prefers morning meetings",
		]);
	});

	// Removed: "refusal suppression on planning path (elizaOS/eliza#7620)"
	// describe block. The refusal-sanitization fallback was deleted along with
	// the `refusal-detector` module. Under `toolChoice: "required"` + per-turn
	// action tools, the model picks the right tool directly — there is no
	// "model contradicts its own routing decision" case to repair.

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

	it("parses extract.facts and extract.relationships when present", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["memory"],
				facts: ["the user's birthday is 1990-03-05", "  ", ""],
				relationships: [
					{ subject: "user", predicate: "works_with", object: "Alice" },
					{ subject: "user", predicate: "", object: "Bob" },
				],
			}),
		);
		expect(parsed?.extract?.facts).toEqual([
			"the user's birthday is 1990-03-05",
		]);
		expect(parsed?.extract?.relationships).toEqual([
			{ subject: "user", predicate: "works_with", object: "Alice" },
		]);
	});

	it("omits extract when no facts or relationships were emitted", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "hi",
				contexts: ["simple"],
			}),
		);
		expect(parsed?.extract).toBeUndefined();
	});
});
