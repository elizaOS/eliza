import { describe, expect, it } from "vitest";
import {
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
} from "../message-handler";

describe("v5 message handler routing", () => {
	it("returns final reply for empty contexts with simple reply", () => {
		const output = {
			action: "RESPOND" as const,
			thought: "Direct answer.",
			contexts: [],
			reply: "Hello.",
			simple: true,
		};

		expect(routeMessageHandlerOutput(output)).toEqual({
			type: "final_reply",
			reply: "Hello.",
			output,
		});
	});

	it("routes simple replies to planning when contexts are available", () => {
		const output = {
			action: "RESPOND" as const,
			reply: "Hello.",
			simple: true,
			contexts: ["calendar"],
			thought: "Calendar context is needed.",
		};

		expect(routeMessageHandlerOutput(output).type).toBe("planning_needed");
	});

	it("parses JSON message handler output", () => {
		expect(
			parseMessageHandlerOutput(`{
  "action": "RESPOND",
  "thought": "Direct.",
  "contexts": [],
  "reply": "Done.",
  "simple": true
}`),
		).toMatchObject({
			action: "RESPOND",
			thought: "Direct.",
			contexts: [],
			reply: "Done.",
			simple: true,
		});
	});
});
