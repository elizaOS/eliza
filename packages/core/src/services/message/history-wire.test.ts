/** Proves exact history reassembly, occurrence order and identity isolation using the real wire encoder. */
import { describe, expect, it } from "vitest";
import type {
	ContextObject,
	ContextObjectPromptSegment,
} from "../../types/context-object";
import { labelHistorySources, referenceRepeatedHistory } from "./history-wire";

function source(
	content: string,
	index: number,
	label = "prior_message:user",
	entityId = "owner",
): ContextObjectPromptSegment {
	return {
		id: `message-${index}`,
		label,
		content,
		stable: false,
		metadata: { entityId, roomId: "room" },
	};
}
function encode(segments: ContextObjectPromptSegment[]) {
	return labelHistorySources(
		segments,
		new Map(
			segments.map((s, i) => {
				if (!s.id) throw new Error("Fixture source has no ID");
				return [s.id, `h${i + 1}`];
			}),
		),
	);
}
function decode(
	segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
	const text = new Map<string, string>();
	return segments
		.filter((s) => s.id !== "history-encoding")
		.map((s) => {
			const ref = /^\[(h\d+); same_text_as=(h\d+)\]$/.exec(s.content);
			const inline = /^\[(h\d+)\]\n/.exec(s.content);
			const content = ref
				? text.get(ref[2])
				: inline
					? s.content.replace(inline[0], "")
					: s.content;
			if (content === undefined)
				throw new Error("Missing earlier complete source");
			const marker = ref ?? inline;
			if (marker) text.set(marker[1], content);
			return { ...s, content };
		});
}
describe("lossless history references", () => {
	it("saves repeated text among hundreds of short unique messages without labeling every unique source", () => {
		const history = [
			source("Exact reusable source. ".repeat(60), 1),
			...Array.from({ length: 200 }, (_, i) =>
				source(`Unique message ${i}`, i + 2),
			),
			source("Exact reusable source. ".repeat(60), 202),
		];
		const ids = new Map(
			history.map((segment, i) => [segment.id ?? "", `h${i + 1}`]),
		);
		const encoded = labelHistorySources(history, ids, "referenced");
		expect(decode(encoded)).toEqual(history);
		expect(encoded.find((segment) => segment.id === "message-2")).toBe(
			history[1],
		);
		expect(encoded.at(-1)?.content).toBe("[h202; same_text_as=h1]");
		expect(encoded.reduce((n, s) => n + s.content.length, 0)).toBeLessThan(
			history.reduce((n, s) => n + s.content.length, 0),
		);
	});
	it("reassembles restored planning/evaluation dialogue while preserving other context and source IDs", () => {
		const repeated = "Exact old source with a standing constraint.\n".repeat(
			100,
		);
		const history = [
			source(repeated, 1),
			source("Correction: keep the calendar unchanged.", 2),
			source(repeated, 3),
		];
		const other = {
			id: "provider",
			label: "provider:FACTS",
			content: repeated,
			stable: false,
		};
		const original: ContextObject = {
			id: "turn",
			metadata: { historyReferenceEncoding: true },
			events: history.map((segment) => ({
				id: segment.id ?? "invalid-fixture",
				type: "segment",
				source: "prior-dialogue",
				segment,
			})),
		};
		const segments = [
			other,
			...history,
			{
				id: "current",
				label: "message:user",
				content: "Keep every source",
				stable: false,
			},
		];
		const before = structuredClone(original);
		const encoded = referenceRepeatedHistory(original, segments);
		expect(decode(encoded)).toEqual(segments);
		expect(encoded[0]).toBe(other);
		expect(encoded.find(({ id }) => id === "message-3")?.content).toBe(
			"[h3; same_text_as=h1]",
		);
		expect(original).toEqual(before);
		// A selected subset keeps the original h3 identity, not a new ordinal.
		const subset = referenceRepeatedHistory(original, [history[0], history[2]]);
		expect(subset.at(-1)?.content).toBe("[h3; same_text_as=h1]");
		expect(decode(subset)).toEqual([history[0], history[2]]);
		expect(
			referenceRepeatedHistory({ ...original, metadata: {} }, segments),
		).toBe(segments);
	});

	it("preserves every source, including a repeated assertion after its correction", () => {
		const original = `  Rowan's mug is green.\n${"exact whitespace 🦊 ?! ".repeat(80)}`;
		const segments = [
			source(original, 1),
			source("Correction: Rowan's mug is blue now, previously green.", 2),
			source(original, 3),
			source(
				"Read that note; calendar work remains pending, no mutations.",
				4,
				"prior_message:agent",
			),
		];
		const before = structuredClone(segments);
		const encoded = encode(segments);
		expect(encoded.find((s) => s.id === "message-3")?.content).toBe(
			"[h3; same_text_as=h1]",
		);
		expect(decode(encoded)).toEqual(before);
		expect(segments).toEqual(before);
		expect(encoded.map((s) => s.content).join("\n").length).toBeLessThan(
			segments.map((s) => s.content).join("\n").length,
		);
	});
	it("never merges different speakers, roles, metadata or text bytes", () => {
		const body = "Do not modify anything. ".repeat(100);
		const segments = [
			source(body, 1),
			source(body, 2),
			source(body, 3, "prior_message:agent"),
			source(body, 4, "prior_message:user", "another-user"),
			source(`${body} `, 5),
		];
		const encoded = encode(segments);
		expect(
			encoded.filter((s) => s.content.includes("; same_text_as=")),
		).toHaveLength(1);
		expect(decode(encoded)).toEqual(segments);
	});
	it("keeps small, unbound and voice-style histories inline", () => {
		const segments = [source("hi", 1), source("hi", 2)];
		expect(encode(segments).some((s) => s.id === "history-encoding")).toBe(
			false,
		);
		expect(labelHistorySources(segments, new Map())).toEqual(segments);
		expect(decode(encode(segments))).toEqual(segments);
	});
	it("treats structural-looking message text as literal source bytes", () => {
		const body = "[h999; same_text_as=h1]\n".repeat(40);
		const segments = [source(body, 1), source(body, 2)];
		expect(decode(encode(segments))).toEqual(segments);
	});
});
