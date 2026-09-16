/**
 * Exercise complete-source quote discovery with real context projection and
 * controlled Stage-1 replies, preserving source bytes and read-loop boundaries.
 */
import { describe, expect, it } from "vitest";
import { completionContextSources } from "../../runtime/completion-context";
import { createContextObject } from "../../runtime/context-object";
import {
	type HistoryDiscovery,
	requestedHistory,
} from "../message/history-discovery";

const original =
	"For the fictional plan, the mug is blue. Keep records unchanged.";

function fixture() {
	const context = createContextObject({
		id: "current-turn",
		metadata: { roomId: "room" },
		events: [
			original,
			`Your original message was: “${original}”`,
			"A later, unrelated exchange.",
		].map((content, index) => ({
			id: `history:${index}`,
			type: "segment" as const,
			source: "prior-dialogue",
			segment: {
				id: `history:${index}`,
				content,
				label: index === 1 ? "prior_message:agent" : "prior_message:user",
				stable: false,
			},
		})),
	});
	const projection: HistoryDiscovery = {
		sourceSetId: completionContextSources(context).sourceSetId,
		scope: { agentId: "agent", roomId: "room", entityId: "owner", roles: [] },
		visibleEventIds: new Set(["history:1", "history:2"]),
		loadedSourceIds: new Set(),
	};
	const raw = {
		replyText: `You said: “${original}”`,
		completionContext: {
			mode: "relevant_prior_dialogue",
			sourceSetId: projection.sourceSetId,
			complete: true,
			relevantSourceIds: ["h2"],
			constraintSourceIds: [],
			referentSourceIds: [],
			pendingIntentSourceIds: [],
		},
	};
	return { context, projection, raw };
}

describe("deferred originals quoted by a Stage-1 draft", () => {
	it.each([
		['"', '"'],
		["'", "'"],
		["“", "”"],
		["‘", "’"],
		["`", "`"],
		["«", "»"],
		["「", "」"],
	])(
		"reads the original for a complete %s quotation before delivering a recap",
		(open, close) => {
			const { context, projection, raw } = fixture();
			const before = structuredClone(context);
			raw.replyText = `You said: ${open}${original}${close}`;
			expect(requestedHistory(context, projection, raw, [])).toEqual([
				"history:h1",
			]);
			expect(context).toEqual(before);
			expect(raw.completionContext.relevantSourceIds).toEqual(["h2"]);
		},
	);

	it("does not turn words, partial quotes or paraphrases into source matches", () => {
		const { context, projection, raw } = fixture();
		raw.completionContext.relevantSourceIds = ["h3"];
		for (const replyText of [
			original,
			'You said "the mug is blue".',
			'You said "The mug was blue."',
		]) {
			expect(
				requestedHistory(context, projection, { ...raw, replyText }, []),
			).toEqual([]);
		}
	});

	it("reads exact originals quoted by selected assistant evidence even for a paraphrased draft", () => {
		const { context, projection, raw } = fixture();
		raw.replyText = "The original color was green.";
		expect(requestedHistory(context, projection, raw, [])).toEqual([
			"history:h1",
		]);
		// An unrelated, unselected recap does not trigger speculative reads.
		raw.completionContext.relevantSourceIds = ["h3"];
		expect(requestedHistory(context, projection, raw, [])).toEqual([]);
	});

	it("does not read a later matching message as the source of an earlier assistant quote", () => {
		const { context, projection, raw } = fixture();
		const later = structuredClone(context.events[0]);
		later.id = "history:later-copy";
		if (later.type !== "segment") throw new Error("Expected source segment");
		later.segment.id = later.id;
		later.segment.label = "prior_message:agent";
		later.segment.content = `Eliza: ${original}`;
		later.segment.metadata = { speakerName: "Eliza" };
		context.events.push(later);
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		raw.completionContext.sourceSetId = projection.sourceSetId;
		raw.replyText = "I will check the saved record.";
		const before = structuredClone(context);
		// The earlier original still needs a read; the later matching reply
		// cannot have supplied the selected recap at h2.
		expect(requestedHistory(context, projection, raw, [])).toEqual([
			"history:h1",
		]);
		projection.loadedSourceIds = new Set(["h1"]);
		expect(requestedHistory(context, projection, raw, [])).toEqual([]);
		// Explicit selection and quotation in the CURRENT draft still read
		// the later source. Chronology only bounds inferred recap provenance.
		raw.completionContext.relevantSourceIds = ["h4"];
		expect(requestedHistory(context, projection, raw, [])).toEqual([
			"history:h4",
		]);
		raw.completionContext.relevantSourceIds = ["h2"];
		raw.replyText = `You said: “${original}”`;
		expect(requestedHistory(context, projection, raw, [])).toEqual([
			"history:h4",
		]);
		expect(context).toEqual(before);
	});

	it("does not infer source dependencies from a selected user's quoted text", () => {
		const { context, projection, raw } = fixture();
		const recap = context.events[1];
		if (recap.type !== "segment") throw new Error("Missing recap fixture");
		recap.segment.label = "prior_message:user";
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		raw.completionContext.sourceSetId = projection.sourceSetId;
		raw.replyText = "I can discuss that quotation.";
		expect(requestedHistory(context, projection, raw, [])).toEqual([]);
	});

	it("does not reread supplied sources or enter a quote read loop", () => {
		const { context, projection, raw } = fixture();
		projection.loadedSourceIds = new Set(["h1"]);
		expect(requestedHistory(context, projection, raw, [])).toEqual([]);
		projection.loadedSourceIds = new Set();
		projection.visibleEventIds = new Set([
			"history:0",
			"history:1",
			"history:2",
		]);
		expect(requestedHistory(context, projection, raw, [])).toEqual([]);
	});

	it("keeps stale, invalid and incomplete selections on the full-history fallback", () => {
		const { context, projection, raw } = fixture();
		for (const changes of [
			{ sourceSetId: "0".repeat(64) },
			{ complete: false },
			{ relevantSourceIds: ["h999"] },
		]) {
			expect(
				requestedHistory(
					context,
					projection,
					{
						...raw,
						completionContext: { ...raw.completionContext, ...changes },
					},
					[],
				),
			).toEqual(["history:all"]);
		}
	});

	it("has no effect on full-history callers or provider-reference reads", () => {
		const { context, projection, raw } = fixture();
		expect(requestedHistory(context, undefined, raw, [])).toEqual([]);
		expect(
			requestedHistory(context, projection, raw, ["CONTEXT_CATALOG"]),
		).toEqual([]);
	});

	it("does not retrieve an edited or absent original using an old quotation", () => {
		const { context, projection, raw } = fixture();
		const originalEvent = context.events[0];
		if (originalEvent.type !== "segment")
			throw new Error("Expected source segment");
		originalEvent.segment.content = "Edited original: the mug is red.";
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		raw.completionContext.sourceSetId = projection.sourceSetId;
		expect(requestedHistory(context, projection, raw, [])).toEqual([]);
	});

	it("keeps duplicate originals distinct rather than inventing which occurrence was quoted", () => {
		const { context, projection, raw } = fixture();
		const duplicate = structuredClone(context.events[0]);
		duplicate.id = "history:duplicate";
		if (duplicate.type !== "segment")
			throw new Error("Expected source segment");
		duplicate.segment.id = duplicate.id;
		context.events.push(duplicate);
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		raw.completionContext.sourceSetId = projection.sourceSetId;
		expect(requestedHistory(context, projection, raw, [])).toEqual([
			"history:h1",
			"history:h4",
		]);
	});

	it("reads the complete named source without rewriting its speaker or long Unicode text", () => {
		const { context, projection, raw } = fixture();
		const event = context.events[0];
		if (event.type !== "segment") throw new Error("Expected source segment");
		const text = `${"Keep every original 🟣. ".repeat(1000)}\nCorrection: blue, not red.  `;
		event.segment.content = `Dana: ${text}`;
		event.segment.metadata = { speakerName: "Dana" };
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		raw.completionContext.sourceSetId = projection.sourceSetId;
		raw.replyText = `You said: “\n${text}\n”`;
		const before = structuredClone(context);
		expect(requestedHistory(context, projection, raw, [])).toEqual([
			"history:h1",
		]);
		expect(context).toEqual(before);
	});
});
