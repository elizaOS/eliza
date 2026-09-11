/** Proves exact history reassembly, occurrence order and identity isolation using the real wire encoder. */
import { describe, expect, it } from "vitest";
import type { ContextObjectPromptSegment } from "../../types/context-object";
import { labelHistorySources } from "./history-wire";

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
			const ref = /^\[completion_source=(h\d+); same_text_as=(h\d+)\]$/.exec(
				s.content,
			);
			const inline = /^\[completion_source=(h\d+)\]\n/.exec(s.content);
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
			"[completion_source=h3; same_text_as=h1]",
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
		const body = "[completion_source=h999; same_text_as=h1]\n".repeat(40);
		const segments = [source(body, 1), source(body, 2)];
		expect(decode(encode(segments))).toEqual(segments);
	});
});
