/**
 * Unit tests for ScoreCard: validates signal ingestion, filtering by source/kind,
 * weighted composite calculation, and serialization round-trip.
 */
import { describe, expect, it } from "vitest";
import { ScoreCard } from "./prompt-optimization-score-card.ts";

describe("ScoreCard", () => {
	it("returns 0 composite score when no signals are present", () => {
		const card = new ScoreCard();
		expect(card.signals.length).toBe(0);
		expect(card.composite()).toBe(0);
	});

	it("ingests signals and filters by source and kind", () => {
		const card = new ScoreCard();
		card.add({ source: "evaluator", kind: "clarity", value: 0.8 });
		card.add({ source: "evaluator", kind: "conciseness", value: 0.9 });
		card.add({ source: "user", kind: "satisfaction", value: 1.0 });

		expect(card.signals.length).toBe(3);
		expect(card.bySource("evaluator").length).toBe(2);
		expect(card.byKind("clarity").length).toBe(1);
		expect(card.byKind("satisfaction").length).toBe(1);
	});

	it("skips invalid or NaN signal values in composite calculation", () => {
		const card = new ScoreCard();
		card.add({ source: "evaluator", kind: "clarity", value: 0.8, weight: 1.0 });
		card.add({
			source: "evaluator",
			kind: "bad",
			value: Number.NaN,
			weight: 1.0,
		});

		expect(card.composite()).toBeCloseTo(0.8, 5);
	});

	it("computes weighted composite score correctly", () => {
		const card = new ScoreCard();
		card.add({ source: "evaluator", kind: "k1", value: 0.5, weight: 2.0 });
		card.add({ source: "evaluator", kind: "k2", value: 1.0, weight: 1.0 });

		// (0.5 * 2 + 1.0 * 1) / (2 + 1) = 2.0 / 3.0 = 0.666...
		expect(card.composite()).toBeCloseTo(0.666666, 4);
	});

	it("supports weight overrides in constructor and composite call", () => {
		const card = new ScoreCard({ "custom:metric": 3.0 });
		card.add({ source: "custom", kind: "metric", value: 0.6 });

		expect(card.composite()).toBeCloseTo(0.6, 5);
	});

	it("serializes to JSON and reconstructs via fromJSON", () => {
		const card = new ScoreCard();
		card.add({ source: "s1", kind: "k1", value: 0.75, weight: 1.0 });

		const json = card.toJSON();
		expect(json.compositeScore).toBeCloseTo(0.75, 5);
		expect(json.signals.length).toBe(1);

		const reconstructed = ScoreCard.fromJSON(json);
		expect(reconstructed.signals.length).toBe(1);
		expect(reconstructed.composite()).toBeCloseTo(0.75, 5);
	});
});
