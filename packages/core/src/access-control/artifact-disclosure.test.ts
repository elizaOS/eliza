/**
 * Unit contract for the role-aware artifact disclosure decision (#14781):
 * the OWNER/ADMIN-full / USER-grant-driven / fail-closed matrix and the
 * untrusted grant parser. Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import type { AccessContext, UUID } from "../types";
import {
	canAccessArtifact,
	parseArtifactShareGrants,
	parseArtifactShareMetadata,
	resolveArtifactDisclosure,
	selectArtifactVariant,
} from "./artifact-disclosure";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;

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
		for (const c of [
			ctx({ role: "OWNER", isOwner: true }),
			ctx({ role: "ADMIN" }),
		]) {
			expect(
				resolveArtifactDisclosure({ scope: "owner-private" }, c, AGENT),
			).toBe("full");
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
