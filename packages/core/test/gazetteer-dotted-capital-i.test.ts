/**
 * The case-insensitive gazetteer searches a lowercased copy of the text and
 * reads offsets back from the original. "İ" (U+0130) lowercases to two code
 * units, so a roster name after it was looked up one index too far and failed
 * the word-boundary check. Transcript redaction feeds Turkish titles and
 * segments through this recognizer.
 */
import { describe, expect, it } from "vitest";
import {
	CompositeEntityRecognizer,
	GazetteerEntityRecognizer,
	RegexEntityRecognizer,
} from "../src/security/entity-recognizer.ts";
import { PseudonymSession } from "../src/security/pii-pseudonymizer.ts";

function roster(...names: string[]) {
	return new GazetteerEntityRecognizer(
		names.map((value) => ({ kind: "person", value })),
		{ name: "roster" },
	);
}

describe("GazetteerEntityRecognizer with a dotted capital I", () => {
	it("locates a roster name that follows İ", async () => {
		const text = "İstanbul ekibi: Ayşe Kaya katıldı.";
		const start = text.indexOf("Ayşe Kaya");

		const spans = await roster("Ayşe Kaya").recognize(text);

		expect(spans).toEqual([
			{
				kind: "person",
				value: "Ayşe Kaya",
				start,
				end: start + "Ayşe Kaya".length,
				score: 1,
			},
		]);
	});

	it("matches a roster name that contains İ in any case", async () => {
		const text = "Toplantı notu: İLKER DEMİR ve Ayşe Kaya geldi.";

		const spans = await roster("İlker Demir", "Ayşe Kaya").recognize(text);

		expect(spans.map((span) => span.value).sort()).toEqual([
			"Ayşe Kaya",
			"İLKER DEMİR",
		]);
		for (const span of spans) {
			expect(text.slice(span.start, span.end)).toBe(span.value);
		}
	});

	it("pseudonymizes a roster name in a transcript-style corpus with a Turkish title", async () => {
		const segment = "Teşekkürler Ayşe Kaya, güncelleme için.";
		const corpus = [
			"İstanbul ekibi haftalık toplantı",
			"Speaker 1",
			segment,
		].join("\n");
		const session = new PseudonymSession({
			salt: "dotted-capital-i",
			recognizer: new CompositeEntityRecognizer([
				new RegexEntityRecognizer(),
				roster("Ayşe Kaya"),
			]),
		});

		await session.learn(corpus);

		expect(session.entries.map((entry) => entry.value)).toEqual(["Ayşe Kaya"]);
		expect(session.substituteText(segment)).not.toContain("Ayşe Kaya");
	});
});
