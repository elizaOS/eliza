/**
 * Exercises the shared outbound sanitization boundary inside
 * `wrapSingleTurnVisibleCallback` (services/message) — the per-turn wrap every
 * connector-visible delivery funnels through. Drives the REAL wrap function
 * with a typed capture callback and the real structured logger; no part of the
 * unit under test is mocked.
 */
import { describe, expect, it } from "vitest";
import { logger } from "../../logger";
import type { Content, HandlerCallback, Memory, UUID } from "../../types";
import { stringToUuid } from "../../utils";
import { wrapSingleTurnVisibleCallback } from "../message";

interface DeliveredCall {
	content: Content;
	actionName: string | undefined;
}

function buildHarness(): {
	delivered: DeliveredCall[];
	recorded: string[];
	wrapped: HandlerCallback;
} {
	const delivered: DeliveredCall[] = [];
	const recorded: string[] = [];
	const callback: HandlerCallback = async (content, actionName) => {
		delivered.push({ content, actionName });
		return [];
	};
	const runtime: { agentId: UUID; logger: typeof logger } = {
		agentId: stringToUuid("outbound-sanitize-agent"),
		logger,
	};
	const message: Pick<Memory, "id" | "roomId" | "entityId"> = {
		id: stringToUuid("outbound-sanitize-message"),
		roomId: stringToUuid("outbound-sanitize-room"),
		entityId: stringToUuid("outbound-sanitize-user"),
	};
	const wrapped = wrapSingleTurnVisibleCallback(
		runtime,
		message,
		callback,
		(text) => recorded.push(text),
	);
	if (!wrapped) {
		throw new Error("wrapSingleTurnVisibleCallback returned no callback");
	}
	return { delivered, recorded, wrapped };
}

describe("outbound sanitization at the visible-callback boundary", () => {
	it("delivers sanitized text to the connector callback", async () => {
		const { delivered, wrapped } = buildHarness();

		await wrapped(
			{
				text: "Let me try the weather action.<tool_call>get_weather",
				actions: ["REPLY"],
				thought: "checking the weather",
			},
			"REPLY",
		);

		expect(delivered).toHaveLength(1);
		expect(delivered[0].content.text).toBe("Let me try the weather action.");
		// Only `text` is rewritten — the structured fields the planner and
		// downstream consumers rely on pass through untouched.
		expect(delivered[0].content.actions).toEqual(["REPLY"]);
		expect(delivered[0].content.thought).toBe("checking the weather");
		expect(delivered[0].actionName).toBe("REPLY");
	});

	it("records both raw and sanitized text for planner-echo suppression", async () => {
		const { recorded, wrapped } = buildHarness();

		await wrapped(
			{ text: "Done.<tool_call>get_weather</tool_call>", actions: ["REPLY"] },
			"REPLY",
		);

		// The suppression set is compared against the planner's UNsanitized
		// finalMessage, so the raw form must stay recognizable alongside the
		// sanitized wire text.
		expect(recorded).toEqual([
			"Done.<tool_call>get_weather</tool_call>",
			"Done.",
		]);
	});

	it("records clean text exactly once", async () => {
		const { recorded, wrapped } = buildHarness();

		await wrapped({ text: "All clear.", actions: ["REPLY"] }, "REPLY");

		expect(recorded).toEqual(["All clear."]);
	});

	it("passes fenced documentation examples through unchanged", async () => {
		const { delivered, wrapped } = buildHarness();
		const fenced =
			"The format is:\n```xml\n<tool_call>get_weather</tool_call>\n```\nUse it verbatim.";

		await wrapped({ text: fenced, actions: ["REPLY"] }, "REPLY");

		expect(delivered[0].content.text).toBe(fenced);
	});

	it("delivers text-free content untouched instead of fabricating a text field", async () => {
		const { delivered, recorded, wrapped } = buildHarness();
		const audioOnly: Content = {
			attachments: [],
			source: "voice",
		};

		await wrapped(audioOnly, "REPLY");

		expect(delivered[0].content).toBe(audioOnly);
		expect(delivered[0].content.text).toBeUndefined();
		expect(recorded).toEqual([]);
	});

	it("delivers an all-machine-syntax turn as empty text for the connector to degrade", async () => {
		const { delivered, wrapped } = buildHarness();

		await wrapped(
			{ text: "<tool_call>get_weather</tool_call>", actions: ["REPLY"] },
			"REPLY",
		);

		// The connector's own empty-text handling (skip send / components-only
		// fallback) owns this case; the boundary just reports the truth.
		expect(delivered[0].content.text).toBe("");
	});
});
