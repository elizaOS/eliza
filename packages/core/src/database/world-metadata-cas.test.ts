/**
 * Exercises the world-metadata compare-and-swap helpers directly.
 *
 * `worldMetadataValueEquals` is the CAS comparison itself: `runtime.ts:4918`,
 * `inMemoryAdapter.ts:1827`, `plugin-sql/src/base.ts:5289` and
 * `plugin-inmemorydb/adapter.ts:1740` all gate a write on it. A wrong `true`
 * there is a lost update, not a failed assertion — so the interesting cases are
 * the ones where two metadata objects are jsonb-equal without being `===`, and
 * the ones where they merely look equal.
 *
 * The revision helpers around it decide whether a legacy whole-world write is
 * allowed to proceed at all. Their documented contract is that a stale or
 * malformed request is an OBSERVABLE failure, never a silent lost update.
 *
 * Deterministic and pure — no adapter, runtime, or database.
 */
import { describe, expect, it } from "vitest";
import type { Metadata } from "../types/primitives.ts";
import {
	advanceWorldMetadataRevision,
	appendWorldMetadataRoleAudit,
	getWorldMetadataRevision,
	initializeWorldMetadataRevision,
	mergeWorldMetadataForLegacyWrite,
	requireFreshWorldMetadataRevision,
	WORLD_METADATA_REVISION_KEY,
	WORLD_METADATA_ROLE_AUDIT_KEY,
	worldMetadataValueEquals,
} from "./world-metadata-cas.ts";

const rev = (value: unknown): Metadata =>
	({ [WORLD_METADATA_REVISION_KEY]: value }) as unknown as Metadata;

describe("worldMetadataValueEquals follows jsonb semantics", () => {
	it("ignores key order and treats explicit undefined as absent", () => {
		expect(worldMetadataValueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(worldMetadataValueEquals({ a: 1, b: undefined }, { a: 1 })).toBe(
			true,
		);
		expect(worldMetadataValueEquals({ a: 1 }, { a: 1, b: undefined })).toBe(
			true,
		);
	});

	// The undefined filter runs on BOTH sides. Dropping either half makes the
	// comparison asymmetric, which is why both directions are asserted above
	// and a same-count-different-keys pair is asserted here: without the
	// `Object.hasOwn` check, `{a:1,b:2}` and `{a:1,c:2}` have equal key counts.
	it("distinguishes objects with the same key count but different keys", () => {
		expect(worldMetadataValueEquals({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(
			false,
		);
	});

	// `Object.hasOwn` and "is not undefined" are different questions. A present
	// key holding `undefined` is filtered out of the counts, so only a key that
	// is genuinely absent may make the comparison false here.
	it("treats a present-but-undefined key as absent on the right", () => {
		expect(worldMetadataValueEquals({ a: 1 }, { a: 1, b: undefined })).toBe(
			true,
		);
		expect(worldMetadataValueEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
	});

	// Both directions of "one side has a defined key the other lacks". The
	// right-heavy case is the one the key-count check exists for: every LEFT
	// key is present and equal on the right, so without comparing counts the
	// subset would compare equal to its superset.
	it("never equates a subset with its superset", () => {
		expect(worldMetadataValueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(worldMetadataValueEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
		expect(worldMetadataValueEquals({}, { a: 1 })).toBe(false);
		expect(worldMetadataValueEquals({ a: 1 }, {})).toBe(false);
	});

	it("compares arrays by length and position, not membership", () => {
		expect(worldMetadataValueEquals([1, 2], [1, 2])).toBe(true);
		expect(worldMetadataValueEquals([1, 2], [2, 1])).toBe(false);
		expect(worldMetadataValueEquals([1, 2], [1, 2, 3])).toBe(false);
		expect(worldMetadataValueEquals([1, 2, 3], [1, 2])).toBe(false);
	});

	// An array and an object with the same numeric keys are jsonb-distinct.
	// Without the Array.isArray branch the object path would compare them by
	// key and call them equal.
	it("never equates an array with an object", () => {
		expect(worldMetadataValueEquals([1, 2], { 0: 1, 1: 2 })).toBe(false);
		expect(worldMetadataValueEquals({ 0: 1, 1: 2 }, [1, 2])).toBe(false);
	});

	it("recurses into nested values", () => {
		expect(
			worldMetadataValueEquals(
				{ roles: { a: "OWNER" }, list: [{ x: 1 }] },
				{ list: [{ x: 1 }], roles: { a: "OWNER" } },
			),
		).toBe(true);
		expect(
			worldMetadataValueEquals(
				{ roles: { a: "OWNER" } },
				{ roles: { a: "ADMIN" } },
			),
		).toBe(false);
	});

	it("returns false for unequal primitives and for NaN", () => {
		expect(worldMetadataValueEquals(1, "1")).toBe(false);
		expect(worldMetadataValueEquals(null, undefined)).toBe(false);
		expect(worldMetadataValueEquals(Number.NaN, Number.NaN)).toBe(false);
	});
});

describe("getWorldMetadataRevision fails closed on a malformed value", () => {
	it("starts a pre-contract world at zero", () => {
		expect(getWorldMetadataRevision(undefined)).toBe(0);
		expect(getWorldMetadataRevision({} as Metadata)).toBe(0);
	});

	it("accepts a non-negative safe integer", () => {
		expect(getWorldMetadataRevision(rev(0))).toBe(0);
		expect(getWorldMetadataRevision(rev(7))).toBe(7);
		expect(getWorldMetadataRevision(rev(Number.MAX_SAFE_INTEGER))).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});

	// `null` is the fail-closed signal that callers turn into a thrown stale
	// write. A revision that is a number but not a usable one — a float, a
	// negative, an unsafe integer, an infinity — must reach that signal rather
	// than being used as a counter.
	it.each([
		["a float", 1.5],
		["a negative", -1],
		["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
		["Infinity", Number.POSITIVE_INFINITY],
		["NaN", Number.NaN],
		["a numeric string", "1"],
		["null", null],
		["an object", {}],
	])("rejects %s", (_label, value) => {
		expect(getWorldMetadataRevision(rev(value))).toBeNull();
	});
});

describe("requireFreshWorldMetadataRevision", () => {
	it("returns the shared revision when both sides agree", () => {
		expect(requireFreshWorldMetadataRevision(rev(3), rev(3), "world")).toBe(3);
		expect(
			requireFreshWorldMetadataRevision(undefined, undefined, "world"),
		).toBe(0);
	});

	// The two failures carry different `reason` codes, and the distinction is
	// the diagnosis: a mismatch means someone raced you, a malformed value
	// means the stored row itself is wrong. Collapsing them loses that.
	it("reports a mismatch as revision_mismatch", () => {
		expect(() =>
			requireFreshWorldMetadataRevision(rev(4), rev(3), "world"),
		).toThrow(/stale revision/);
		try {
			requireFreshWorldMetadataRevision(rev(4), rev(3), "world");
			expect.unreachable("expected a stale-revision failure");
		} catch (error) {
			const context = (error as { context?: Record<string, unknown> }).context;
			expect(context).toMatchObject({
				worldId: "world",
				storedRevision: 4,
				writerRevision: 3,
				reason: "revision_mismatch",
			});
		}
	});

	it.each([
		["stored", rev("bad"), rev(1)],
		["writer", rev(1), rev("bad")],
		["both", rev("bad"), rev(-1)],
	])("reports a malformed %s revision as malformed_revision", (_l, a, b) => {
		try {
			requireFreshWorldMetadataRevision(a, b, "world");
			expect.unreachable("expected a stale-revision failure");
		} catch (error) {
			const context = (error as { context?: Record<string, unknown> }).context;
			expect(context).toMatchObject({ reason: "malformed_revision" });
		}
	});
});

describe("mergeWorldMetadataForLegacyWrite protects authority state", () => {
	const stored = {
		[WORLD_METADATA_REVISION_KEY]: 5,
		roles: { alice: "OWNER" },
		roleSources: { alice: "invite" },
		topic: "old",
	} as unknown as Metadata;

	// The comment on the delete calls this out: an incoming owner-only
	// projection built during message ingestion must never replace the stored
	// role map. Merging ordinary keys while refusing these two is the whole
	// point of the function.
	it("keeps stored roles and roleSources over incoming ones", () => {
		const merged = mergeWorldMetadataForLegacyWrite(
			stored,
			{
				roles: { bob: "OWNER" },
				roleSources: { bob: "message" },
				topic: "new",
			} as unknown as Metadata,
			"world",
		);
		expect(merged.roles).toEqual({ alice: "OWNER" });
		expect(merged.roleSources).toEqual({ alice: "invite" });
		expect(merged.topic).toBe("new");
	});

	// When the stored world has no role map, the incoming projection is the
	// only source of one — and it still must not become the world's authority
	// state. Both keys are checked: the stored-side restore below covers each
	// only when stored HAS the key, so this is the case where the delete is
	// the sole thing standing in the way.
	it.each([["roles"], ["roleSources"]])(
		"omits %s entirely when the stored world never had it",
		(key) => {
			const merged = mergeWorldMetadataForLegacyWrite(
				rev(1),
				{ [key]: { bob: "OWNER" }, topic: "new" } as unknown as Metadata,
				"world",
			);
			expect(Object.hasOwn(merged, key)).toBe(false);
			expect(merged.topic).toBe("new");
		},
	);

	// The revision is adapter-owned: a caller cannot advance or rewind it by
	// putting one in its payload.
	it("pins the revision to the stored one, ignoring the caller's", () => {
		const merged = mergeWorldMetadataForLegacyWrite(stored, rev(99), "world");
		expect(merged[WORLD_METADATA_REVISION_KEY]).toBe(5);
	});

	it("does not alias the stored object", () => {
		const source = {
			[WORLD_METADATA_REVISION_KEY]: 1,
			roles: { alice: "OWNER" },
		} as unknown as Metadata;
		const merged = mergeWorldMetadataForLegacyWrite(source, {}, "world");
		(merged.roles as Record<string, string>).alice = "ADMIN";
		expect((source.roles as Record<string, string>).alice).toBe("OWNER");
	});

	it("refuses to merge onto a malformed stored revision", () => {
		expect(() =>
			mergeWorldMetadataForLegacyWrite(rev("bad"), {}, "world"),
		).toThrow(/malformed/);
	});
});

describe("advanceWorldMetadataRevision", () => {
	it("increments by one and clones", () => {
		const source = { topic: "t" } as unknown as Metadata;
		const next = advanceWorldMetadataRevision(source, 4);
		expect(next[WORLD_METADATA_REVISION_KEY]).toBe(5);
		expect(Object.hasOwn(source, WORLD_METADATA_REVISION_KEY)).toBe(false);
	});

	it.each([
		["a negative", -1],
		["a float", 1.5],
		["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
		["NaN", Number.NaN],
	])("refuses %s current revision", (_label, current) => {
		expect(() => advanceWorldMetadataRevision({}, current)).toThrow(
			/revision is invalid/,
		);
	});

	// One below the ceiling still advances; the ceiling itself is exhausted
	// rather than overflowing into an unsafe integer.
	it("advances at the ceiling minus one and refuses the ceiling", () => {
		expect(
			advanceWorldMetadataRevision({}, Number.MAX_SAFE_INTEGER - 1)[
				WORLD_METADATA_REVISION_KEY
			],
		).toBe(Number.MAX_SAFE_INTEGER);
		expect(() =>
			advanceWorldMetadataRevision({}, Number.MAX_SAFE_INTEGER),
		).toThrow(/exhausted/);
	});
});

describe("appendWorldMetadataRoleAudit", () => {
	it("appends in order and clones the entry", () => {
		const audit = { actor: "alice" };
		const once = appendWorldMetadataRoleAudit(undefined, audit);
		const twice = appendWorldMetadataRoleAudit(once, { actor: "bob" });
		expect(twice[WORLD_METADATA_ROLE_AUDIT_KEY]).toEqual([
			{ actor: "alice" },
			{ actor: "bob" },
		]);
		audit.actor = "mallory";
		expect(
			(once[WORLD_METADATA_ROLE_AUDIT_KEY] as { actor: string }[])[0]?.actor,
		).toBe("alice");
	});

	// A non-array prior value is discarded rather than spread. Spreading a
	// string would explode it into characters and a number would throw.
	it.each([
		["a string", "not-an-array"],
		["a number", 7],
		["an object", { nope: true }],
		["null", null],
	])("restarts the audit when the prior value is %s", (_label, prior) => {
		const result = appendWorldMetadataRoleAudit(
			{ [WORLD_METADATA_ROLE_AUDIT_KEY]: prior } as unknown as Metadata,
			{ actor: "alice" },
		);
		expect(result[WORLD_METADATA_ROLE_AUDIT_KEY]).toEqual([{ actor: "alice" }]);
	});
});

describe("initializeWorldMetadataRevision", () => {
	// "without trusting caller input" — a caller-supplied revision on a brand
	// new world must not carry over.
	it("forces zero over any caller-supplied revision", () => {
		expect(
			initializeWorldMetadataRevision(rev(42))[WORLD_METADATA_REVISION_KEY],
		).toBe(0);
		expect(
			initializeWorldMetadataRevision(undefined)[WORLD_METADATA_REVISION_KEY],
		).toBe(0);
	});

	it("preserves other metadata and does not alias it", () => {
		const source = { topic: "t", nested: { a: 1 } } as unknown as Metadata;
		const initialized = initializeWorldMetadataRevision(source);
		expect(initialized.topic).toBe("t");
		(initialized.nested as { a: number }).a = 2;
		expect((source.nested as { a: number }).a).toBe(1);
	});
});
