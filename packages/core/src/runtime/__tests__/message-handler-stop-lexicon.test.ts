/** Ensures an explicit STOP decision cannot dispatch a stale action plan based on an English word list. */
import { describe, expect, it } from "vitest";
import { routeMessageHandlerOutput } from "../../../../../plugins/plugin-assistant/src/runtime/message-handler.ts";

function output(processMessage: "RESPOND" | "IGNORE" | "STOP") {
	return {
		processMessage,
		thought: "",
		plan: {
			contexts: ["calendar"],
			intents: ["add calendar event"],
			reply: "",
			replyEffectStatus: "none",
			simple: false,
			requiresTool: true,
			candidateActions: ["CALENDAR_CREATE_EVENT"],
		},
		extract: { facts: [], relationships: [], addressedTo: [], topics: [] },
	} as never;
}

describe("routeMessageHandlerOutput stop contract", () => {
	it("stops when the user actually asked to stop", () => {
		expect(
			routeMessageHandlerOutput(output("STOP"), {
				messageText: "ok stop, leave me alone for a bit",
			}).type,
		).toBe("stopped");
		expect(routeMessageHandlerOutput(output("STOP"), {}).type).toBe("stopped");
	});

	it.each([
		"No continúes, por favor.",
		"それ以上続けないでください。",
		"Please cease this task.",
	])("honors STOP for %s", (messageText) => {
		expect(
			routeMessageHandlerOutput(output("STOP"), { messageText }).type,
		).toBe("stopped");
	});
});
