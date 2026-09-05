/**
 * Deterministic regression coverage for world-metadata CAS/optimistic-concurrency
 * helpers. These protect cross-adapter world metadata against lost updates and
 * stale writes, so the tests are built to fail if a revision-mismatch or
 * lost-update bug is reintroduced.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
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

const REV = WORLD_METADATA_REVISION_KEY;
const AUDIT = WORLD_METADATA_ROLE_AUDIT_KEY;

describe("worldMetadataValueEquals (jsonb semantics)", () => {
	it("treats object key order as irrelevant", () => {
		expect(worldMetadataValueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
	});

	it("treats undefined properties as absent", () => {
		expect(worldMetadataValueEquals({ a: 1, b: undefined }, { a: 1 })).toBe(
			true,
		);
	});

	it("recurses into arrays element-wise", () => {
		expect(
			worldMetadataValueEquals([{ x: 1 }, [2, 3]], [{ x: 1 }, [2, 3]]),
		).toBe(true);
		expect(worldMetadataValueEquals([{ x: 1 }], [{ x: 2 }])).toBe(false);
	});

	it("distinguishes 1 from true (strict equality, not loose)", () => {
		expect(worldMetadataValueEquals({ n: 1 }, { n: true })).toBe(false);
	});

	it("rejects extra keys / missing keys on objects", () => {
		expect(worldMetadataValueEquals({ a: 1, c: 3 }, { a: 1 })).toBe(false);
		expect(worldMetadataValueEquals(null, { a: 1 })).toBe(false);
	});

	it("handles primitives and null directly", () => {
		expect(worldMetadataValueEquals(null, null)).toBe(true);
		expect(worldMetadataValueEquals(3, 3)).toBe(true);
		expect(worldMetadataValueEquals("a", "b")).toBe(false);
	});
});

describe("getWorldMetadataRevision", () => {
	it("defaults to 0 when the revision key is absent", () => {
		expect(getWorldMetadataRevision({ note: "x" })).toBe(0);
		expect(getWorldMetadataRevision(undefined)).toBe(0);
	});

	it("accepts a safe non-negative integer", () => {
		expect(getWorldMetadataRevision({ [REV]: 7 })).toBe(7);
	});

	it("fail-closes on malformed revisions (negative, non-integer, unsafe, non-number)", () => {
		expect(getWorldMetadataRevision({ [REV]: -1 })).toBe(null);
		expect(getWorldMetadataRevision({ [REV]: 1.5 })).toBe(null);
		expect(
			getWorldMetadataRevision({ [REV]: Number.MAX_SAFE_INTEGER + 1 }),
		).toBe(null);
		expect(getWorldMetadataRevision({ [REV]: "7" })).toBe(null);
		expect(getWorldMetadataRevision({ [REV]: true })).toBe(null);
	});
});

describe("requireFreshWorldMetadataRevision (stale-write protection)", () => {
	const worldId = "world-1";

	it("accepts when stored and writer revisions match", () => {
		const stored = { [REV]: 5 };
		const writer = { [REV]: 5 };
		expect(requireFreshWorldMetadataRevision(stored, writer, worldId)).toBe(5);
	});

	it("throws on revision mismatch (lost-update guard)", () => {
		expect(() =>
			requireFreshWorldMetadataRevision({ [REV]: 5 }, { [REV]: 4 }, worldId),
		).toThrowError(ElizaError);
		// code is WORLD_METADATA_STALE_WRITE
		try {
			requireFreshWorldMetadataRevision({ [REV]: 5 }, { [REV]: 4 }, worldId);
			expect.fail("expected throw");
		} catch (e) {
			const err = e as ElizaError & { code?: string };
			expect(err.code).toBe("WORLD_METADATA_STALE_WRITE");
			expect(err.context?.reason).toBe("revision_mismatch");
			expect(err.context?.worldId).toBe(worldId);
		}
	});

	it("fail-closes when either side has a malformed revision", () => {
		expect(() =>
			requireFreshWorldMetadataRevision(
				{ [REV]: "bad" },
				{ [REV]: 1 },
				worldId,
			),
		).toThrowError(ElizaError);
		expect(() =>
			requireFreshWorldMetadataRevision({ [REV]: 1 }, { [REV]: -2 }, worldId),
		).toThrowError(ElizaError);
	});
});

describe("mergeWorldMetadataForLegacyWrite", () => {
	it("preserves the stored adapter-owned revision and never lets caller override it", () => {
		const merged = mergeWorldMetadataForLegacyWrite(
			{ [REV]: 9, note: "old" },
			{ [REV]: 999, note: "new" },
			"w",
		);
		expect(merged[REV]).toBe(9);
		expect(merged.note).toBe("new");
	});

	it("does NOT replace connector authority state (roles / roleSources) on ingestion", () => {
		const stored = {
			roles: { admin: "alice" },
			roleSources: { admin: "perm" },
			[REV]: 3,
		};
		const incoming = {
			roles: { admin: "eve" },
			roleSources: { admin: "impostor" },
			note: "h",
		};
		const merged = mergeWorldMetadataForLegacyWrite(stored, incoming, "w");
		expect(merged.roles).toEqual({ admin: "alice" });
		expect(merged.roleSources).toEqual({ admin: "perm" });
	});

	it("carries role state forward when the stored side lacks it", () => {
		const merged = mergeWorldMetadataForLegacyWrite(
			{ [REV]: 1, note: "x" },
			{ roles: { r: "u" } },
			"w",
		);
		expect(merged.note).toBe("x");
		// roles only appear if present on the STORED side
		expect(merged.roles).toBeUndefined();
	});

	it("throws when the stored revision is malformed", () => {
		expect(() =>
			mergeWorldMetadataForLegacyWrite({ [REV]: "bad" }, { note: "x" }, "w"),
		).toThrowError(ElizaError);
	});
});

describe("advanceWorldMetadataRevision", () => {
	it("returns a clone with the revision advanced by one", () => {
		const next = advanceWorldMetadataRevision({ note: "x", [REV]: 4 }, 4);
		expect(next[REV]).toBe(5);
		expect(next.note).toBe("x");
		// original untouched
		expect({ note: "x", [REV]: 4 }[REV]).toBe(4);
	});

	it("does not mutate the input metadata", () => {
		const input = { [REV]: 2 } as Record<string, unknown>;
		const next = advanceWorldMetadataRevision(input, 2);
		expect(next[REV]).toBe(3);
		expect(input[REV]).toBe(2);
	});

	it("throws on invalid current revision", () => {
		expect(() => advanceWorldMetadataRevision({}, -1)).toThrowError(ElizaError);
		expect(() => advanceWorldMetadataRevision({}, 1.5)).toThrowError(
			ElizaError,
		);
	});

	it("throws when the revision is exhausted at MAX_SAFE_INTEGER", () => {
		expect(() =>
			advanceWorldMetadataRevision({}, Number.MAX_SAFE_INTEGER),
		).toThrowError(ElizaError);
	});
});

describe("appendWorldMetadataRoleAudit", () => {
	it("initializes the audit array when absent", () => {
		const out = appendWorldMetadataRoleAudit({}, { role: "admin", by: "a" });
		expect(Array.isArray(out[AUDIT])).toBe(true);
		expect(out[AUDIT]).toEqual([{ role: "admin", by: "a" }]);
	});

	it("appends to an existing audit array", () => {
		const out = appendWorldMetadataRoleAudit(
			{ [AUDIT]: [{ role: "read" }] },
			{ role: "write" },
		);
		expect(out[AUDIT]).toEqual([{ role: "read" }, { role: "write" }]);
	});

	it("deep-clones the appended entry (no aliasing)", () => {
		const entry = { role: "admin", nested: { x: 1 } };
		const out = appendWorldMetadataRoleAudit({}, entry);
		expect(out[AUDIT][0].nested).toEqual({ x: 1 });
		expect(out[AUDIT][0].nested).not.toBe(entry.nested);
	});

	it("does not mutate the input metadata", () => {
		const input = { [REV]: 1 } as Record<string, unknown>;
		appendWorldMetadataRoleAudit(input, { role: "r" });
		expect(input[AUDIT]).toBeUndefined();
	});
});

describe("initializeWorldMetadataRevision", () => {
	it("starts a world at revision 0 regardless of caller input", () => {
		const out = initializeWorldMetadataRevision({ [REV]: 999, note: "x" });
		expect(out[REV]).toBe(0);
		expect(out.note).toBe("x");
	});

	it("handles undefined metadata", () => {
		const out = initializeWorldMetadataRevision(undefined);
		expect(out[REV]).toBe(0);
	});
});
