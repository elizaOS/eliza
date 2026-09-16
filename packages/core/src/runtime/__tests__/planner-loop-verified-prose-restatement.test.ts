/**
 * Combined verified-tool-text + prose reply: prose that only restates the
 * verified result is dropped; prose carrying any new content word is kept.
 * Pure helper, no runtime.
 */
import { describe, expect, it } from "vitest";
import { proseRestatesVerifiedText } from "../planner-loop";

describe("proseRestatesVerifiedText", () => {
	const moved = "Moved “Vet appointment” to Friday, Sep 18 at 4pm EDT.";

	it("drops a closing sentence that says the verified outcome again (live 2026-09-15: both were delivered as one message)", () => {
		expect(
			proseRestatesVerifiedText(
				"Moved it. Vet appointment is now Friday, Sep 18 at 4pm EDT.",
				moved,
			),
		).toBe(true);
		expect(
			proseRestatesVerifiedText("Done, moved to Friday at 4pm.", moved),
		).toBe(true);
	});

	it("drops a paraphrase with synonyms and reformatted times of a single-line verified reply (live 2026-09-15: re-voiced into a third wording)", () => {
		const created =
			"Created “Barber appointment” for Friday, Sep 18 at 3pm EDT.";
		expect(
			proseRestatesVerifiedText(
				"Added a Barber appointment for Friday, Sep 18 at 3:00 PM EDT.",
				created,
			),
		).toBe(true);
		expect(
			proseRestatesVerifiedText(
				"Your barber appointment is set for Friday, Sep 18 at 3 pm EDT.",
				created,
			),
		).toBe(true);
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

	it("never collapses against a verified text too short to stand alone", () => {
		expect(proseRestatesVerifiedText("Saved.", "Saved.")).toBe(false);
		expect(proseRestatesVerifiedText("", moved)).toBe(false);
	});
});
