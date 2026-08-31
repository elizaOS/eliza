/**
 * Owns the legacy-write authority-retention contract of world-metadata-cas:
 * a possibly-stale caller snapshot passed to mergeWorldMetadataForLegacyWrite
 * must never erase adapter-owned authority state (roles, roleSources, the
 * optimistic revision, and the role-write audit history) from the stored
 * world. Harness is real and deterministic: the exported helpers are executed
 * directly with real metadata objects, no mocks.
 */
import { describe, expect, it } from "vitest";
import type { Metadata } from "../types/primitives";
import {
	appendWorldMetadataRoleAudit,
	mergeWorldMetadataForLegacyWrite,
	WORLD_METADATA_REVISION_KEY,
	WORLD_METADATA_ROLE_AUDIT_KEY,
} from "./world-metadata-cas";

function storedWorldWithAudit(): Metadata {
	let stored: Metadata = {
		[WORLD_METADATA_REVISION_KEY]: 5,
		theme: "dark",
	};
	stored = appendWorldMetadataRoleAudit(stored, {
		actorEntityId: "a1",
		newRole: "admin",
	});
	stored = appendWorldMetadataRoleAudit(stored, {
		actorEntityId: "a2",
		newRole: "moderator",
	});
	return stored;
}

describe("mergeWorldMetadataForLegacyWrite audit retention", () => {
	it("retains the stored audit history when the caller snapshot carries a stale shorter audit", () => {
		const stored = storedWorldWithAudit();
		const staleIncoming: Metadata = {
			[WORLD_METADATA_REVISION_KEY]: 5,
			theme: "dark",
			[WORLD_METADATA_ROLE_AUDIT_KEY]: [
				{ actorEntityId: "a1", newRole: "admin" },
			],
		};

		const merged = mergeWorldMetadataForLegacyWrite(
			stored,
			staleIncoming,
			"world-1",
		);

		const rows = merged[WORLD_METADATA_ROLE_AUDIT_KEY] as unknown[];
		// The stored history (a1, a2) survives; the stale single-row snapshot
		// must not replace it.
		expect(rows).toHaveLength(2);
		expect(rows).toEqual(stored[WORLD_METADATA_ROLE_AUDIT_KEY]);
	});

	it("retains the stored audit history when the caller snapshot has no audit key at all", () => {
		const stored = storedWorldWithAudit();
		const incoming: Metadata = {
			[WORLD_METADATA_REVISION_KEY]: 5,
			theme: "light",
		};

		const merged = mergeWorldMetadataForLegacyWrite(
			stored,
			incoming,
			"world-1",
		);

		expect(merged[WORLD_METADATA_ROLE_AUDIT_KEY]).toEqual(
			stored[WORLD_METADATA_ROLE_AUDIT_KEY],
		);
		// Ordinary observations still merge through.
		expect(merged.theme).toBe("light");
	});

	it("drops a caller-supplied audit when the stored world has no audit history", () => {
		// Mirrors the roles/roleSources semantics: the audit key is
		// adapter-owned authority state, so a caller-supplied value never
		// passes through even when the stored world has nothing to protect.
		const stored: Metadata = { [WORLD_METADATA_REVISION_KEY]: 2 };
		const incoming: Metadata = {
			[WORLD_METADATA_REVISION_KEY]: 2,
			[WORLD_METADATA_ROLE_AUDIT_KEY]: [
				{ actorEntityId: "a9", newRole: "admin" },
			],
		};

		const merged = mergeWorldMetadataForLegacyWrite(
			stored,
			incoming,
			"world-1",
		);

		expect(Object.hasOwn(merged, WORLD_METADATA_ROLE_AUDIT_KEY)).toBe(false);
	});

	it("still pins the revision and role maps while retaining the audit", () => {
		const storedRoles = { admin: ["a1"] };
		const stored: Metadata = {
			...storedWorldWithAudit(),
			roles: storedRoles,
			roleSources: { admin: "authority" },
		};
		const incoming: Metadata = {
			[WORLD_METADATA_REVISION_KEY]: 999,
			roles: {},
			roleSources: {},
			[WORLD_METADATA_ROLE_AUDIT_KEY]: [],
		};

		const merged = mergeWorldMetadataForLegacyWrite(
			stored,
			incoming,
			"world-1",
		);

		expect(merged.roles).toEqual(storedRoles);
		expect(merged.roleSources).toEqual({ admin: "authority" });
		expect(merged[WORLD_METADATA_REVISION_KEY]).toBe(5);
		expect(merged[WORLD_METADATA_ROLE_AUDIT_KEY]).toEqual(
			stored[WORLD_METADATA_ROLE_AUDIT_KEY],
		);
	});

	it("never mutates the caller or stored metadata objects", () => {
		const stored = storedWorldWithAudit();
		const storedSnapshot = structuredClone(stored);
		const staleIncoming: Metadata = {
			[WORLD_METADATA_REVISION_KEY]: 5,
			[WORLD_METADATA_ROLE_AUDIT_KEY]: [
				{ actorEntityId: "a1", newRole: "admin" },
			],
		};
		const incomingSnapshot = structuredClone(staleIncoming);

		const merged = mergeWorldMetadataForLegacyWrite(
			stored,
			staleIncoming,
			"world-1",
		);

		expect(stored).toEqual(storedSnapshot);
		expect(staleIncoming).toEqual(incomingSnapshot);
		// The merged audit array is a detached copy, not the stored reference:
		// mutating the merged result never rewrites stored history.
		(merged[WORLD_METADATA_ROLE_AUDIT_KEY] as unknown[]).pop();
		expect(stored[WORLD_METADATA_ROLE_AUDIT_KEY]).toHaveLength(2);
	});
});
