/**
 * Canonical deep JSON-value equality for world-metadata compare-and-swap
 * (#23100). The stored `World.metadata` is a live object in the in-memory
 * adapters and a jsonb column in SQL, so snapshot comparison must be by VALUE
 * with key order insignificant and `undefined` treated as absent — matching
 * how a JSON round-trip drops it. This is the comparison that decides whether
 * a role write is a legitimate swap or a conflict, so it is security-relevant:
 * a single implementation shared by every first-party adapter makes
 * environment-dependent drift impossible rather than merely unlikely.
 *
 * Consumed by `database/inMemoryAdapter.ts`, `plugin-inmemorydb/adapter.ts`,
 * and `plugin-sql/src/base.ts`. Load-bearing invariants an editor must
 * preserve: plain objects compare by enumerated own keys (undefined-valued
 * keys are absent); arrays compare element-wise and only against arrays; and
 * EXOTIC values (Date, Map, class instances — anything that is not a plain
 * object or array) never deep-compare, so a snapshot carrying an unverifiable
 * shape reports a conflict instead of silently succeeding — fail closed, the
 * same direction every access gate in this repository takes.
 */
import { isPlainObject } from "./type-guards";

/**
 * Deep JSON-value equality for world-metadata compare-and-swap snapshots.
 * Returns `true` only when `left` and `right` are structurally identical as
 * JSON values (key order irrelevant, `undefined` absent). Anything non-JSON
 * on both sides compares by `===` at the top of each recursion, so two
 * distinct Dates — or two distinct class instances — are NOT equal even
 * though both enumerate zero own keys.
 */
export function jsonValueEquals(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (isPlainObject(left) && isPlainObject(right)) {
		const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
		const rightKeys = Object.keys(right).filter(
			(key) => right[key] !== undefined,
		);
		if (leftKeys.length !== rightKeys.length) return false;
		return leftKeys.every((key) =>
			jsonValueEquals(
				left[key],
				Object.hasOwn(right, key) ? right[key] : undefined,
			),
		);
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => jsonValueEquals(item, right[index]))
		);
	}
	return false;
}
