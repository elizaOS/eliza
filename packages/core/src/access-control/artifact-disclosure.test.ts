/**
 * Unit contract for the role-aware artifact disclosure decision (#14778):
 * the OWNER/ADMIN-full / USER-grant-driven / fail-closed matrix and the
 * untrusted grant parser. Pure functions, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { AccessContext, Memory, UUID } from "../types";
import {
	type ArtifactVariantReferences,
	artifactDisclosureRecordFromMemory,
	canAccessArtifact,
	parseArtifactShareGrants,
	parseArtifactShareMetadata,
	resolveArtifactDisclosure,
	resolveArtifactDisclosureForMemory,
	selectArtifactVariant,
	selectDisclosedArtifactUrl,
} from "./artifact-disclosure";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;

const typedShareMemory: Pick<Memory, "entityId" | "metadata"> = {
	entityId: OTHER,
	metadata: {
		type: "message",
		scope: "owner-private",
		share: {
			grants: [{ entityId: VIEWER, mode: "redacted" }],
		},
	},
};

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
	requesterEntityId: VIEWER,
	...over,
});

describe("resolveArtifactDisclosure", () => {
	it("no access context (single-owner local boundary) → full", () => {
		expect(
			resolveArtifactDisclosure({ scope: "owner-private" }, undefined, AGENT),
		).toBe("full");
	});

	it("agent self-read → full", () => {
		expect(
			resolveArtifactDisclosure(
				{ scope: "owner-private" },
				ctx({ requesterEntityId: AGENT }),
				AGENT,
			),
		).toBe("full");
	});

	it("OWNER and ADMIN rank → full regardless of scope or grants", () => {
		for (const scope of [
			"owner-private",
			"agent-private",
			"user-private",
			"private",
		] as const) {
			for (const c of [
				ctx({ role: "OWNER", isOwner: true }),
				ctx({ role: "ADMIN" }),
			]) {
				expect(resolveArtifactDisclosure({ scope }, c, AGENT)).toBe("full");
			}
		}
	});

	it("USER with a full grant → full even on owner-private scope", () => {
		expect(
			resolveArtifactDisclosure(
				{
					scope: "owner-private",
					scopedEntityId: OWNER,
					grants: [{ entityId: VIEWER, mode: "full" }],
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("full");
	});

	it("accepts the typed share metadata contract directly", () => {
		expect(
			resolveArtifactDisclosure(
				{
					scope: "owner-private",
					scopedEntityId: OWNER,
					share: { grants: [{ entityId: VIEWER, mode: "full" }] },
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("full");
	});

	it("USER with a redacted grant → redacted", () => {
		expect(
			resolveArtifactDisclosure(
				{
					scope: "owner-private",
					scopedEntityId: OWNER,
					grants: [{ entityId: VIEWER, mode: "redacted" }],
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("redacted");
	});

	it("a redacted grant narrows the viewer even when scope is global", () => {
		expect(
			resolveArtifactDisclosure(
				{
					scope: "global",
					grants: [{ entityId: VIEWER, mode: "redacted" }],
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("redacted");
	});

	it("someone else's grant does not disclose to this viewer", () => {
		expect(
			resolveArtifactDisclosure(
				{
					scope: "owner-private",
					scopedEntityId: OWNER,
					grants: [{ entityId: OTHER, mode: "full" }],
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("none");
	});

	it("ungranted USER falls back to the scope ladder", () => {
		// owner-private default fails closed…
		expect(
			resolveArtifactDisclosure(
				{ scope: "owner-private", scopedEntityId: OWNER },
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("none");
		// …global stays readable…
		expect(
			resolveArtifactDisclosure(
				{ scope: "global" },
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("full");
		// …and a user still reads their OWN user-private record.
		expect(
			resolveArtifactDisclosure(
				{ scope: "user-private", scopedEntityId: VIEWER },
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("full");
		expect(
			resolveArtifactDisclosure(
				{ scope: "user-private", scopedEntityId: OTHER },
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe("none");
	});

	it("GUEST role collapses to the least-privileged tier: omitted on owner-private", () => {
		expect(
			resolveArtifactDisclosure(
				{ scope: "owner-private", scopedEntityId: OWNER },
				ctx({ role: "GUEST" }),
				AGENT,
			),
		).toBe("none");
	});

	it("unresolved role (no world) fails closed to the USER tier", () => {
		expect(
			resolveArtifactDisclosure(
				{ scope: "owner-private", scopedEntityId: OWNER },
				ctx(),
				AGENT,
			),
		).toBe("none");
	});

	it.each([
		"owner-private",
		"agent-private",
		"user-private",
		"private",
	] as const)(
		"GUEST and unresolved authority are denied %s artifacts, including self-scoped records",
		(scope) => {
			for (const accessContext of [ctx({ role: "GUEST" }), ctx()]) {
				expect(
					resolveArtifactDisclosure(
						{ scope, scopedEntityId: VIEWER },
						accessContext,
						AGENT,
					),
				).toBe("none");
			}
		},
	);

	it.each(["global", "shared", "room"] as const)(
		"unresolved authority preserves explicitly open %s disclosure",
		(scope) => {
			expect(resolveArtifactDisclosure({ scope }, ctx(), AGENT)).toBe("full");
		},
	);
});

describe("canAccessArtifact", () => {
	it("returns true for full and redacted disclosures, false for omitted rows", () => {
		expect(
			canAccessArtifact(
				{
					scope: "owner-private",
					grants: [{ entityId: VIEWER, mode: "full" }],
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe(true);
		expect(
			canAccessArtifact(
				{
					scope: "owner-private",
					grants: [{ entityId: VIEWER, mode: "redacted" }],
				},
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe(true);
		expect(
			canAccessArtifact(
				{ scope: "owner-private", scopedEntityId: OWNER },
				ctx({ role: "USER" }),
				AGENT,
			),
		).toBe(false);
	});
});

describe("selectArtifactVariant", () => {
	it("selects full references only for full disclosure", () => {
		expect(
			selectArtifactVariant("full", {
				full: "/api/media/full.wav",
				redacted: "/api/media/redacted.txt",
			}),
		).toEqual({ disclosure: "full", value: "/api/media/full.wav" });
	});

	it("selects redacted references without falling back to full bytes", () => {
		expect(
			selectArtifactVariant("redacted", {
				full: "/api/media/full.wav",
				redacted: "/api/media/redacted.txt",
			}),
		).toEqual({ disclosure: "redacted", value: "/api/media/redacted.txt" });
		expect(
			selectArtifactVariant("redacted", {
				full: "/api/media/full.wav",
			}),
		).toBeNull();
	});

	it("omits artifacts for none disclosure", () => {
		expect(
			selectArtifactVariant("none", {
				full: "/api/media/full.wav",
				redacted: "/api/media/redacted.txt",
			}),
		).toBeNull();
	});

	it("does not read full or redacted references after a denied decision", () => {
		const readFullFromProvider = vi.fn(() => "/api/media/full.wav");
		const readRedactedFromStorage = vi.fn(() => "/api/media/redacted.txt");
		const references = {} as ArtifactVariantReferences<string>;
		Object.defineProperties(references, {
			full: { enumerable: true, get: readFullFromProvider },
			redacted: { enumerable: true, get: readRedactedFromStorage },
		});

		expect(selectArtifactVariant("none", references)).toBeNull();
		expect(readFullFromProvider).not.toHaveBeenCalled();
		expect(readRedactedFromStorage).not.toHaveBeenCalled();
	});
});

describe("parseArtifactShareGrants", () => {
	it("parses well-formed grants and preserves issuer fields", () => {
		const grants = parseArtifactShareGrants({
			share: {
				grants: [
					{
						entityId: VIEWER,
						mode: "redacted",
						grantedBy: OWNER,
						grantedAtMs: 123,
					},
				],
			},
		});
		expect(grants).toEqual([
			{
				entityId: VIEWER,
				mode: "redacted",
				grantedBy: OWNER,
				grantedAtMs: 123,
			},
		]);
	});

	it("drops malformed entries instead of granting anything", () => {
		const grants = parseArtifactShareGrants({
			share: {
				grants: [
					{ entityId: "not-a-uuid", mode: "full" },
					{ entityId: VIEWER, mode: "everything" },
					{ entityId: VIEWER },
					"garbage",
					null,
					{ entityId: VIEWER, mode: "full" },
				],
			},
		});
		expect(grants).toEqual([{ entityId: VIEWER, mode: "full" }]);
	});

	it("returns empty for absent/malformed share metadata", () => {
		expect(parseArtifactShareGrants(undefined)).toEqual([]);
		expect(parseArtifactShareGrants({})).toEqual([]);
		expect(parseArtifactShareGrants({ share: "nope" })).toEqual([]);
		expect(parseArtifactShareGrants({ share: { grants: "nope" } })).toEqual([]);
	});
});

describe("artifactDisclosureRecordFromMemory", () => {
	it("types top-level memory.metadata.share for referencing records", () => {
		expect(artifactDisclosureRecordFromMemory(typedShareMemory)).toEqual({
			scope: "owner-private",
			scopedEntityId: OTHER,
			grants: [{ entityId: VIEWER, mode: "redacted" }],
		});
	});

	it("normalizes stored metadata into a disclosure record", () => {
		const memory = {
			entityId: OTHER,
			metadata: {
				scope: "user-private",
				scopedToEntityId: VIEWER,
				share: {
					grants: [{ entityId: OTHER, mode: "redacted" }],
					roomSnapshot: {
						roomId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
						entityIds: [VIEWER],
						atMs: 123,
					},
				},
			},
		} as Pick<Memory, "entityId" | "metadata">;

		expect(artifactDisclosureRecordFromMemory(memory)).toEqual({
			scope: "user-private",
			scopedEntityId: VIEWER,
			grants: [{ entityId: OTHER, mode: "redacted" }],
		});
	});

	it("fails closed on malformed scope and grants", () => {
		const memory = {
			entityId: OTHER,
			metadata: {
				scope: "public-to-everyone",
				scopedToEntityId: "not-a-uuid",
				share: {
					grants: [{ entityId: VIEWER, mode: "everything" }],
				},
			},
		} as Pick<Memory, "entityId" | "metadata">;

		expect(artifactDisclosureRecordFromMemory(memory)).toEqual({
			scope: "owner-private",
			scopedEntityId: OTHER,
			grants: [],
		});
	});

	it("resolves disclosure from a memory row using stored share metadata", () => {
		const memory = {
			entityId: OWNER,
			metadata: {
				scope: "owner-private",
				share: {
					grants: [{ entityId: VIEWER, mode: "redacted" }],
				},
			},
		} as Pick<Memory, "entityId" | "metadata">;

		expect(
			resolveArtifactDisclosureForMemory(memory, ctx({ role: "USER" }), AGENT),
		).toBe("redacted");
	});
});

describe("selectDisclosedArtifactUrl", () => {
	it("returns the original URL for full disclosure", () => {
		expect(
			selectDisclosedArtifactUrl("full", {
				fullUrl: "/api/media/original.wav",
				redactedUrl: "/api/media/redacted.wav",
			}),
		).toEqual({
			disclosure: "full",
			url: "/api/media/original.wav",
			redacted: false,
		});
	});

	it("returns the redacted URL for redacted disclosure", () => {
		expect(
			selectDisclosedArtifactUrl("redacted", {
				fullUrl: "/api/media/original.wav",
				redactedUrl: "/api/media/redacted.wav",
			}),
		).toEqual({
			disclosure: "redacted",
			url: "/api/media/redacted.wav",
			redacted: true,
		});
	});

	it("omits redacted disclosure when no redacted variant exists", () => {
		expect(
			selectDisclosedArtifactUrl("redacted", {
				fullUrl: "/api/media/original.wav",
			}),
		).toBeNull();
	});

	it("omits none or missing original URL", () => {
		expect(
			selectDisclosedArtifactUrl("none", {
				fullUrl: "/api/media/original.wav",
			}),
		).toBeNull();
		expect(selectDisclosedArtifactUrl("full", {})).toBeNull();
	});
});

describe("parseArtifactShareMetadata", () => {
	it("parses grants and the room snapshot contract", () => {
		expect(
			parseArtifactShareMetadata({
				share: {
					grants: [{ entityId: VIEWER, mode: "full" }],
					roomSnapshot: {
						roomId: OWNER,
						entityIds: [VIEWER, OTHER],
						atMs: 456,
					},
				},
			}),
		).toEqual({
			grants: [{ entityId: VIEWER, mode: "full" }],
			roomSnapshot: {
				roomId: OWNER,
				entityIds: [VIEWER, OTHER],
				atMs: 456,
			},
		});
	});

	it("drops malformed room snapshots without dropping valid grants", () => {
		expect(
			parseArtifactShareMetadata({
				share: {
					grants: [{ entityId: VIEWER, mode: "redacted" }],
					roomSnapshot: {
						roomId: OWNER,
						entityIds: [VIEWER, "not-a-uuid"],
						atMs: 789,
					},
				},
			}),
		).toEqual({
			grants: [{ entityId: VIEWER, mode: "redacted" }],
		});
	});
});
