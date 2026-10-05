/** Exercises the shared tier-0 coverage rule and marker key exports consumed by the cloud scrub lane. */
import { describe, expect, it } from "vitest";
import {
	hashScrubContent,
	PII_SCRUB_MARKER_PREFIX,
	partitionScrubCandidates,
	scrubMarkerKey,
	scrubMarkerKeyForContent,
} from "../index";

describe("partitionScrubCandidates", () => {
	it("treats equal, contained and blank candidates as covered and keeps the rest as residue", () => {
		const partition = partitionScrubCandidates(
			["4111 1111 1111 1111", "1111", "  ", "Ada Lovelace"],
			["4111 1111 1111 1111"],
		);
		expect(partition.covered).toEqual(["4111 1111 1111 1111", "1111", "  "]);
		expect(partition.residue).toEqual(["Ada Lovelace"]);
	});

	it("keeps every non-blank candidate as residue when tier-0 found nothing", () => {
		expect(partitionScrubCandidates(["Ada"], [])).toEqual({
			covered: [],
			residue: ["Ada"],
		});
	});
});

describe("scrub marker keys", () => {
	it("builds pii:<sha256>:v<ruleset> from content", () => {
		const hash = hashScrubContent("hello");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(scrubMarkerKeyForContent("hello", "3")).toBe(
			`${PII_SCRUB_MARKER_PREFIX}:${hash}:v3`,
		);
	});

	it("refuses a version-collapsed key", () => {
		expect(() => scrubMarkerKey(hashScrubContent("x"), "")).toThrow(
			/rulesetVersion/,
		);
	});
});
