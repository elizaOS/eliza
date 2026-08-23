/**
 * Regression for app-control views score comparators — imports production comparators.
 */
import { describe, expect, it } from "vitest";
import {
	__testCompareCandidateScore,
	__testCompareScoredView,
	__testCompareScoredViewClose,
	__testCompareScoredViewShow,
} from "./views-comparators.ts";

function scoredView(id: string, score: number) {
	return { view: { id } as any, score };
}
function scoredCandidate(id: string, score: number) {
	return { candidate: { id } as any, score };
}

describe("app-control views safe-sort", () => {
	it("views-create: treats NaN/Infinity as 0", () => {
		const rows = [
			scoredView("b", Number.NaN),
			scoredView("a", 10),
			scoredView("c", Number.POSITIVE_INFINITY),
		];
		expect(
			[...rows].sort(__testCompareScoredView).map((r) => r.view.id),
		).toEqual(["a", "b", "c"]);
	});
	it("views-show: tie-break by view id", () => {
		const rows = [scoredView("b", 5), scoredView("a", 5)];
		expect(
			[...rows].sort(__testCompareScoredViewShow).map((r) => r.view.id),
		).toEqual(["a", "b"]);
	});
	it("views candidate: tie-break by candidate id", () => {
		const rows = [scoredCandidate("zebra", 10), scoredCandidate("apple", 10)];
		expect(
			[...rows].sort(__testCompareCandidateScore).map((r) => r.candidate.id),
		).toEqual(["apple", "zebra"]);
	});
	it("views close: sorts descending", () => {
		const rows = [scoredView("b", 10), scoredView("a", 80)];
		expect(
			[...rows].sort(__testCompareScoredViewClose).map((r) => r.view.id),
		).toEqual(["a", "b"]);
	});
});
