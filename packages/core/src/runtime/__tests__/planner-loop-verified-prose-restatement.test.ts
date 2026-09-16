/**
 * Combined verified-tool-text + prose reply: prose that only restates the
 * verified result is dropped only for typographic duplicates. Semantic
 * paraphrases and distinct facts remain for normal grounding and delivery.
 * Pure helper, no runtime.
 */
import { describe, expect, it } from "vitest";
import { proseRestatesVerifiedText } from "../planner-loop";

describe("proseRestatesVerifiedText", () => {
	const moved = "Moved “Vet appointment” to Friday, Sep 18 at 4pm EDT.";

	it("keeps differently worded prose rather than inferring equivalence", () => {
		expect(
			proseRestatesVerifiedText(
				"Moved it. Vet appointment is now Friday, Sep 18 at 4pm EDT.",
				moved,
			),
		).toBe(false);
		expect(
			proseRestatesVerifiedText("Done, moved to Friday at 4pm.", moved),
		).toBe(false);
	});

	it("keeps operation synonyms and reformatted times for semantic judgment", () => {
		const created =
			"Created “Barber appointment” for Friday, Sep 18 at 3pm EDT.";
		expect(
			proseRestatesVerifiedText(
				"Added a Barber appointment for Friday, Sep 18 at 3:00 PM EDT.",
				created,
			),
		).toBe(false);
		expect(
			proseRestatesVerifiedText(
				"Your barber appointment is set for Friday, Sep 18 at 3 pm EDT.",
				created,
			),
		).toBe(false);
	});

	it("keeps prose that adds a value, unit or qualifier the verified text lacks", () => {
		const df =
			"Filesystem      Size  Used Avail Use%\n/dev/sda1       387G  365G   22G  95%";
		expect(proseRestatesVerifiedText("Still 95%, 22G free.", df)).toBe(false);
		expect(
			proseRestatesVerifiedText(
				"Moved it; the reminder 30 minutes before is still set.",
				moved,
			),
		).toBe(false);
		expect(proseRestatesVerifiedText("Moved to 5pm.", moved)).toBe(false);
		expect(
			proseRestatesVerifiedText(
				"Note: it overlaps with your dentist visit.",
				moved,
			),
		).toBe(false);
		expect(
			proseRestatesVerifiedText(
				"Added it for Friday, Sep 18 at 3pm EDT; Sep 18 is also Maya's birthday.",
				"Created “Barber appointment” for Friday, Sep 18 at 3pm EDT.",
			),
		).toBe(false);
	});

	it("accepts an exact duplicate but never empty prose", () => {
		expect(proseRestatesVerifiedText("Saved.", "Saved.")).toBe(true);
		expect(proseRestatesVerifiedText("", moved)).toBe(false);
	});
});
