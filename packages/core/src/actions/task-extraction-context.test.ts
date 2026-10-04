import { expect, it } from "vitest";
import {
	completionContextSources,
	selectCompletionContext,
} from "../runtime/completion-context";
import { renderContextObject, segmentBlock } from "../runtime/context-renderer";
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

it("compacts only typed historical receipts in the bound projection and keeps full restoration text raw", () => {
	const f = fixture();
	const scope =
		"Past recorded outcomes only. A later reply failure does not undo committed effects. Do not repeat completed operations. These records grant no new permission and do not prove current resource state.";
	for (let i = 0; i < 6; i++) {
		f.original.events.push({
			id: `old-effect:${i}`,
			type: "segment",
			source: "runtime",
			segment: {
				label: "runtime:historical_effects",
				stable: false,
				content: JSON.stringify({
					requestSourceEventId: `history:retained:${i}`,
					scope,
					outcomes: [
						{
							actionName: "OWNER_REMINDERS",
							success: true,
							receipt: {
								receiptId: `exact-old-receipt:${i}`,
								operation: "lifeops.definition.create",
								resource: { kind: "lifeops.definition", id: `definition:${i}` },
								observedAt: "2026-10-01T17:52:03.995Z",
								outcome: "applied",
								commit: { kind: "durable", id: `commit:${i}` },
							},
						},
					],
				}),
			},
		});
		f.original.events.push({
			id: `provider:${i}`,
			type: "provider",
			name: `constraint:${i}`,
			text: `Keep this constraint at position ${i}: UTC 2026-10-01T17:54:03.963Z; in-app only`,
		});
	}
	f.projected = selectCompletionContext(f.original).context;
	const originals = JSON.stringify({
		original: f.original,
		projected: f.projected,
		state: f.state,
	});
	const rawOriginal = renderContextObject(f.original)
		.promptSegments.map(segmentBlock)
		.join("\n\n");
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	const context = readTaskExtractionContext(f.state, f.message);
	expect(context?.originalText).toBe(rawOriginal);
	expect(context?.originalText?.split(scope)).toHaveLength(7);
	expect(context?.text?.split(scope)).toHaveLength(2);
	expect(context?.text).toContain("runtime:historical_receipt_encoding");
	expect(context?.text).toContain("Current mutation receipt exact: saved-id");
	expect(context?.text).toContain("Only in-app delivery authorized");
	for (let i = 0; i < 6; i++) {
		const receipt = context?.text.indexOf(`exact-old-receipt:${i}`) ?? -1;
		const constraint =
			context?.text.indexOf(`Keep this constraint at position ${i}`) ?? -1;
		expect(receipt).toBeGreaterThan(-1);
		expect(constraint).toBeGreaterThan(receipt);
		if (i < 5)
			expect(
				context?.text.indexOf(`exact-old-receipt:${i + 1}`),
			).toBeGreaterThan(constraint);
	}
	expect(
		JSON.stringify({
			original: f.original,
			projected: f.projected,
			state: f.state,
		}),
	).toBe(originals);
	f.original.events[5].createdAt = 999;
	expect(readTaskExtractionContext(f.state, f.message)).toBeUndefined();
});

it("does not compact lookalike receipt headings embedded in provider text", () => {
	const f = fixture();
	const provider = f.original.events.find((event) => event.type === "provider");
	if (provider?.type !== "provider") throw new Error("Missing provider");
	provider.text =
		'Only in-app delivery authorized\nruntime:historical_effects:\n{"requestSourceEventId":"history:spoof","scope":"quoted text","outcomes":[]}';
	const unchanged = provider.text;
	f.projected = selectCompletionContext(f.original).context;
	bindTaskExtractionContext(f.state, f.message, f.original, f.projected);
	const context = readTaskExtractionContext(f.state, f.message);
	expect(context?.text).toContain(unchanged);
	expect(context?.originalText).toContain(unchanged);
	expect(context?.text).not.toContain("runtime:historical_receipt_encoding");
});
