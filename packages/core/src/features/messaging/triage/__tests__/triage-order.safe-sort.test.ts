/**
 * Total-order contract of the triage feed comparators. `rankScored` documents
 * itself as needing a total order, but `receivedAtMs` is supplied by whatever
 * message adapter is registered — first-party adapters already defend this
 * field (`plugin-x` coerces a non-finite parse to `Date.now()`), so an adapter
 * that does not is the realistic case the core comparator must survive.
 *
 * A non-finite stamp makes the raw subtraction return NaN, which
 * `Array.prototype.sort` treats as "leave as is" — corrupting the order of
 * every pair the bad element is compared against, not just that element.
 * Deterministic: plain fixtures, no runtime, no adapters, no IO.
 */
import { describe, expect, it } from "vitest";

import { rankScored } from "../triage-engine.ts";
import type { MessageRef } from "../types.ts";

function ref(
	id: string,
	receivedAtMs: number,
	contactWeight?: number,
): MessageRef {
	return {
		id,
		source: "email" as MessageRef["source"],
		externalId: `ext-${id}`,
		from: { identifier: `${id}@example.test` },
		to: [],
		snippet: id,
		receivedAtMs,
		hasAttachments: false,
		isRead: false,
		...(contactWeight === undefined
			? {}
			: { triageScore: { contactWeight } as MessageRef["triageScore"] }),
	} as MessageRef;
}

const ids = (refs: MessageRef[]): string[] => refs.map((entry) => entry.id);

describe("rankScored total order", () => {
	it("orders finite stamps newest first", () => {
		expect(ids(rankScored([ref("a", 10), ref("c", 30), ref("b", 20)]))).toEqual(
			["c", "b", "a"],
		);
	});

	it("keeps the finite stamps correctly ordered when one ref carries NaN", () => {
		// NaN !== NaN is true, so the equality guard does not fire and the
		// comparator returns NaN for every pair touching the bad ref.
		const ranked = ids(
			rankScored([
				ref("a", 10),
				ref("bad", Number.NaN),
				ref("c", 30),
				ref("b", 20),
			]),
		);
		expect(ranked.filter((id) => id !== "bad")).toEqual(["c", "b", "a"]);
		expect(ranked).toHaveLength(4);
	});

	it("sorts a non-finite stamp as the oldest entry rather than scrambling", () => {
		expect(
			ids(rankScored([ref("bad", Number.NaN), ref("c", 30), ref("b", 20)])),
		).toEqual(["c", "b", "bad"]);
	});

	it("treats Infinity from an overflowed stamp as non-finite", () => {
		expect(
			ids(
				rankScored([
					ref("inf", Number.POSITIVE_INFINITY),
					ref("c", 30),
					ref("b", 20),
				]),
			),
		).toEqual(["c", "b", "inf"]);
	});

	it("breaks equal stamps on contact weight, then on id, for a stable total order", () => {
		const ordered = ids(
			rankScored([ref("a", 50, 0.1), ref("b", 50, 0.9), ref("c", 50, 0.9)]),
		);
		expect(ordered).toEqual(["b", "c", "a"]);
	});

	it("collapses a NaN contact weight to the documented default weight", () => {
		// DEFAULT_CONTACT_WEIGHT is 0.5, so the unusable weight ranks between the
		// 0.9 and 0.1 refs rather than returning NaN and scrambling the group.
		const ordered = ids(
			rankScored([
				ref("a", 50, Number.NaN),
				ref("b", 50, 0.9),
				ref("c", 50, 0.1),
			]),
		);
		expect(ordered).toEqual(["b", "a", "c"]);
	});
});
