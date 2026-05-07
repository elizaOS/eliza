import { describe, expect, it } from "vitest";
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
  "plan": { "contexts": ["simple"], "reply": "Done." }
}`);
		expect(parsed).toMatchObject({
			processMessage: "RESPOND",
			action: "RESPOND",
			thought: "Direct.",
			plan: { contexts: ["simple"], reply: "Done." },
			contexts: ["simple"],
			reply: "Done.",
		});
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
		expect(parsed?.contexts).toEqual([SIMPLE_CONTEXT_ID]);
		expect(parsed?.reply).toBe("Done.");
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
});
