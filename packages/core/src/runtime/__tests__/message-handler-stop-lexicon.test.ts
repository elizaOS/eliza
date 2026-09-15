/**
 * STOP is honored only for an actual disengage request; a STOP verdict on a
 * direct request routes on with its plan (live 2026-09-11/12 misfires).
 *
 * The gate is the English STOP_LEXICON in message-handler.ts. Develop's stop
 * contract pinned that an explicit STOP never dispatches a stale plan based on
 * a word list; the merged router keeps the lexicon gate because the Stage-1
 * STOP misfires it repairs have no other cover, so develop's non-lexicon
 * disengage requests are pinned below as the lexicon's current gap rather
 * than as honored stops. Widening the lexicon flips those cases to "stopped".
 */
import { describe, expect, it } from "vitest";
import { routeMessageHandlerOutput } from "../message-handler";

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

describe("routeMessageHandlerOutput STOP lexicon", () => {
	it("stops when the user actually asked to stop", () => {
		expect(
			routeMessageHandlerOutput(output("STOP"), {
				messageText: "ok stop, leave me alone for a bit",
			}).type,
		).toBe("stopped");
		expect(routeMessageHandlerOutput(output("STOP"), {}).type).toBe("stopped");
	});

	it("routes a STOP verdict on a direct request onward with its plan", () => {
		const route = routeMessageHandlerOutput(output("STOP"), {
			messageText:
				"add a chiropractor appointment friday at 3pm to my calendar",
		});
		expect(route.type).not.toBe("stopped");
		expect(route.type).not.toBe("ignored");
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

	it("honors a STOP the model repeated after the unusable-decision re-ask, whatever the words", () => {
		expect(
			routeMessageHandlerOutput(output("STOP"), {
				messageText: "one line: what's the capital of chile?",
				confirmedStop: true,
			}).type,
		).toBe("stopped");
		expect(
			routeMessageHandlerOutput(output("STOP"), {
				messageText: "one line: what's the capital of chile?",
			}).type,
		).not.toBe("stopped");
	});
});
