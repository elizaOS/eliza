/**
 * Model-wire projection of Stage-1 routing and loop verdict events. Shapes are
 * the live "move it to 4pm" turn (tj-786ca91739ceaa), where every planner and
 * evaluator call carried the event id, creation time and patch debug text.
 */
import { describe, expect, it } from "vitest";
import type { ContextEvent } from "../src/runtime/context-object.ts";
import {
	renderContextObject,
	segmentBlock,
} from "../src/runtime/context-renderer.ts";

function render(event: ContextEvent): string {
	return renderContextObject({ id: "turn", events: [event] })
		.promptSegments.map(segmentBlock)
		.join("\n\n");
}

const draftInstruction =
	"This Stage-1 draft was not delivered and proves neither permission nor execution.";

const stageOneEvent: ContextEvent = {
	id: "message-handler:1793358065290",
	type: "message_handler",
	source: "message-service",
	createdAt: 1793358065290,
	content:
		'Current-request navigation judgment: {"disposition":"planning","viewId":"calendar"}. No navigation has executed.',
	metadata: {
		processMessage: "RESPOND",
		undeliveredDraft: {
			replyText:
				"Done. Coffee with Sam is now tomorrow, Saturday October 31, 4:00 to 5:00 pm.",
			instruction: draftInstruction,
		},
		plan: {
			contexts: ["simple", "general"],
			replyEffectStatus: "applied",
			intents: ["move coffee with Sam to 4pm"],
			requiresTool: true,
			candidateActions: ["CALENDAR_UPDATE_EVENT"],
			parentActionHints: [],
			reply: "",
			responseHandlerPatches: [
				{
					evaluatorName: "core.simple_completed_side_effect_claim",
					changed: ["requiresTool", "contexts:add", "reply:clear"],
					debug: [
						"simple reply claimed a completed side effect with no tool run; rerouting to the planner (candidates: none)",
					],
				},
			],
		},
		thought: "",
	},
};

describe("runtime event rendering", () => {
	it("renders the Stage-1 routing evidence without envelope ids, times or patch diagnostics", () => {
		const block = render(stageOneEvent);
		expect(block.startsWith("event:message_handler:\nmessage_handler: ")).toBe(
			true,
		);
		expect(block).not.toContain("1793358065290");
		expect(block).not.toContain("message-service");
		expect(block).not.toContain("core.simple_completed_side_effect_claim");
		expect(block).not.toContain("rerouting to the planner");
		const projected = JSON.parse(
			block.slice("event:message_handler:\nmessage_handler: ".length),
		);
		expect(projected).toEqual({
			content: stageOneEvent.content,
			metadata: {
				processMessage: "RESPOND",
				undeliveredDraft: {
					replyText:
						"Done. Coffee with Sam is now tomorrow, Saturday October 31, 4:00 to 5:00 pm.",
					instruction: draftInstruction,
				},
				plan: {
					contexts: ["simple", "general"],
					replyEffectStatus: "applied",
					intents: ["move coffee with Sam to 4pm"],
					requiresTool: true,
					candidateActions: ["CALENDAR_UPDATE_EVENT"],
				},
			},
		});
	});

	it("keeps a nonempty Stage-1 thought", () => {
		const block = render({
			...stageOneEvent,
			metadata: { ...stageOneEvent.metadata, thought: "Needs the event." },
		});
		expect(block).toContain('"thought":"Needs the event."');
	});

	it("renders the loop verdict without its event id or creation time", () => {
		const block = render({
			id: "evaluation:5:1793360695756",
			type: "evaluation",
			source: "planner-loop",
			createdAt: 1793360695756,
			metadata: {
				iteration: 5,
				success: false,
				decision: "NEXT_RECOMMENDED",
				thought: "The queued read is grounded in the request.",
				recommendedToolCallId: "06f8d3b52",
			},
		});
		expect(block).toBe(
			'event:evaluation:\nevaluation: {"metadata":{"iteration":5,"success":false,"decision":"NEXT_RECOMMENDED","thought":"The queued read is grounded in the request.","recommendedToolCallId":"06f8d3b52"}}',
		);
	});

	it("keeps events from other producers complete", () => {
		const event: ContextEvent = {
			...stageOneEvent,
			source: "connector",
		};
		expect(render(event)).toBe(
			`event:message_handler:\nmessage_handler: ${JSON.stringify(event)}`,
		);
	});
});
