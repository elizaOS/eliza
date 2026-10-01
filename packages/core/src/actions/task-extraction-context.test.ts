import { expect, it } from "vitest";
import {
	completionContextSources,
	selectCompletionContext,
} from "../runtime/completion-context";
import type { ContextObject } from "../types/context-object";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	bindTaskExtractionContext,
	readTaskExtractionContext,
} from "./task-extraction-context";

function fixture() {
	const message = {
		id: "turn",
		roomId: "room",
		entityId: "owner",
		content: { text: "remind me about that" },
	} as Memory;
	const state: State = {
		text: "full state with all originals",
		values: { selectedActionConversation: "first" },
		data: {},
	};
	const original: ContextObject = {
		id: "turn",
		metadata: { roomId: "room", messageId: "turn" },
		staticPrefix: {
			systemPrompt: {
				content: "Never disclose private material",
				stable: true,
			},
		},
		events: [
			...[
				"user: No native apps",
				"assistant: that is the saved receipt",
				"user: unrelated weather",
			].map((content, i) => ({
				id: `h${i}`,
				type: "segment" as const,
				source: "prior-dialogue",
				segment: {
					id: `h${i}`,
					label: i === 1 ? "prior_message:agent" : "prior_message:user",
					content,
					stable: false,
				},
			})),
			{
				id: "provider",
				type: "provider",
				name: "permissions",
				text: "Only in-app delivery authorized",
			},
			{
				id: "receipt",
				type: "segment",
				source: "test-receipt",
				segment: {
					id: "receipt",
					label: "runtime:historical_effects",
					content: "Current mutation receipt exact: saved-id",
					stable: false,
				},
			},
		],
	};
	original.metadata = {
		...original.metadata,
		completionContext: {
			mode: "selected",
			complete: true,
			sourceSetId: completionContextSources(original).sourceSetId,
			relevantSourceIds: ["h1", "h2"],
			constraintSourceIds: [],
			referentSourceIds: [],
			pendingIntentSourceIds: [],
		},
	};
	return {
		state,
		message,
		original,
		projected: selectCompletionContext(original).context,
	};
}
it("keeps nonhistory constraints, role text and receipts exact while leaving originals unchanged", () => {
	const f = fixture();
	const original = JSON.stringify(f.original);
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	const text = readTaskExtractionContext(f.state, f.message)?.text;
	expect(text).toContain("user: No native apps");
	expect(text).toContain("assistant: that is the saved receipt");
	expect(text).toContain("Only in-app delivery authorized");
	expect(text).toContain(
		"runtime:historical_effects:\nCurrent mutation receipt exact: saved-id",
	);
	expect(text).toContain("Never disclose private material");
	expect(text).not.toContain("unrelated weather");
	expect(JSON.stringify(f.original)).toBe(original);
});
it("separates only an exact live canonical system prefix and preserves other context", () => {
	const f = fixture();
	const prefix = f.original.staticPrefix;
	if (!prefix) throw new Error("Fixture system prefix is missing");
	prefix.characterPrompt = {
		content: "Keep the user's chosen style",
		stable: true,
	};
	const before = JSON.stringify(f.original);
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	const context = readTaskExtractionContext(
		f.state,
		f.message,
		"Never disclose private material",
	);
	expect(context?.system).toBe("Never disclose private material");
	expect(context?.text).not.toContain("Never disclose private material");
	expect(context?.originalText).not.toContain(
		"Never disclose private material",
	);
	expect(context?.text).toContain("Keep the user's chosen style");
	expect(context?.text).toContain("Only in-app delivery authorized");
	expect(context?.text).toContain("Current mutation receipt exact: saved-id");
	expect(context?.originalText).toContain("unrelated weather");
	expect(JSON.stringify(f.original)).toBe(before);
});
it("keeps the full prefix when live role/persona differs or no system comparison is supplied", () => {
	const f = fixture();
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	for (const system of [undefined, "A different live role", ""]) {
		const context = readTaskExtractionContext(f.state, f.message, system);
		expect(Object.hasOwn(context ?? {}, "system")).toBe(false);
		expect(context?.text).toContain("Never disclose private material");
		expect(context?.originalText).toContain("Never disclose private material");
	}
});
it("keeps capability through routing values clone but not JSON, wrong actor/room/message or mutated state/source", () => {
	for (const mutation of [
		"json",
		"actor",
		"room",
		"message",
		"state",
		"source",
		"projected",
		"selection",
	]) {
		const f = fixture();
		bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
		expect(
			readTaskExtractionContext(
				{
					...f.state,
					values: {
						...f.state.values,
						contextRouting: { primaryContext: "reminders" },
					},
				},
				f.message,
			),
		).toBeDefined();
		let state = f.state;
		let message = f.message;
		if (mutation === "json") state = JSON.parse(JSON.stringify(state));
		if (mutation === "actor")
			message = { ...message, entityId: "other" as Memory["entityId"] };
		if (mutation === "room")
			message = { ...message, roomId: "other" as Memory["roomId"] };
		if (mutation === "message")
			message = { ...message, id: "other" as Memory["id"] };
		if (mutation === "state") state.text = "changed";
		if (mutation === "source") f.original.events[2].createdAt = 999;
		if (mutation === "projected") f.projected.events[0].createdAt = 998;
		if (mutation === "selection")
			state.values.selectedActionConversation = "different";
		expect(readTaskExtractionContext(state, message), mutation).toBeUndefined();
	}
});
it("rejects provider or effect removal, full views, invalid request binding", () => {
	for (const mode of ["provider", "receipt", "full", "wrong-request"]) {
		const f = fixture();
		const projected =
			mode === "full"
				? f.original
				: {
						...f.projected,
						events: f.projected.events.filter((x) => x.id !== mode),
					};
		if (mode === "wrong-request") f.message.id = "wrong" as Memory["id"];
		bindTaskExtractionContext(f.state, f.message, f.original, projected);
		expect(readTaskExtractionContext(f.state, f.message), mode).toBeUndefined();
	}
});
it("shared data with another tool selection cannot inherit its projection", () => {
	const f = fixture();
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	const other = {
		...f.state,
		values: { ...f.state.values, selectedActionConversation: "second" },
	};
	bindTaskExtractionContext(other, f.message, f.original, f.projected);
	expect(readTaskExtractionContext(f.state, f.message)).toBeUndefined();
	expect(readTaskExtractionContext(other, f.message)).toBeDefined();
});

it("invalid replacement clears a former binding on shared state data", () => {
	const f = fixture();
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	expect(readTaskExtractionContext(f.state, f.message)).toBeDefined();
	bindTaskExtractionContext(
		f.state,
		f.message,
		{ ...f.original, metadata: { ...f.original.metadata, messageId: "other" } },
		f.projected,
	);
	expect(readTaskExtractionContext(f.state, f.message)).toBeUndefined();
});
