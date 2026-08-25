/**
 * Real-PGlite coverage for the durable capability-grant feature (#23102
 * slice 1). Proves: self-migration (tables created from empty by the store
 * itself), grant CRUD with vocabulary validation, live-grant filtering
 * (expiry + revocation in SQL), deny-wins over simultaneous allows and over
 * the role tier, constraints intersection with incompatible→deny, fail-closed
 * `authorizeCapability` semantics, per-decision audit rows with redaction by
 * construction, optimistic-version conflicts, revocation-epoch bumps,
 * quarantined legacy selectors, and restart survival — the store is opened,
 * closed, and reopened on the SAME disk data dir with grants created in the
 * first process authoritative in the second.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UUID } from "../../types/index.ts";
import { authorizeCapability } from "./authorizeCapability.ts";
import type { CapabilityStoreDb } from "./CapabilityGrantStore.ts";
import {
	createCapabilityGrant,
	getCapabilityEpoch,
	getCapabilityGrant,
	listCapabilityAudit,
	listLiveGrantsFor,
	revokeCapabilityGrant,
	updateCapabilityGrant,
} from "./CapabilityGrantStore.ts";
import { CAPABILITY_BOUNDARY_INVENTORY } from "./capability-boundary-inventory.ts";
import {
	CAPABILITY_REASON_CODES,
	canonicalizeCapabilitySubject,
	canonicalizeResourceSelector,
	selectorMatchesResource,
	validateCapabilityName,
} from "./types.ts";

const MINUTE = 60_000;

const AGENT = "00000000-0000-4000-8000-00000000a111" as UUID;
const WORLD_1 = "00000000-0000-4000-8000-00000000b222" as UUID;
const WORLD_2 = "00000000-0000-4000-8000-00000000b333" as UUID;
const SUBJECT_ENTITY = "entity:00000000-0000-4000-8000-00000000c444";
const SUBJECT_ENTITY_2 = "entity:00000000-0000-4000-8000-00000000c445";
const ISSUER = "entity:00000000-0000-4000-8000-00000000d555";

interface Harness {
	client: PGlite;
	db: CapabilityStoreDb;
	close: () => Promise<void>;
}

/**
 * Opens a store WITHOUT pre-running the DDL: the store must self-migrate.
 * This is the real-boot proof — nothing registers these tables externally.
 */
async function openStore(dataDir: string): Promise<Harness> {
	const client = new PGlite(dataDir);
	const db = drizzle(client) as unknown as CapabilityStoreDb;
	return {
		client,
		db,
		close: async () => {
			await client.close();
		},
	};
}

let dataDir: string;
let store: Harness;

beforeAll(async () => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capgrants-"));
	store = await openStore(dataDir);
}, 120_000);

afterAll(async () => {
	await store?.close();
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("self-migration", () => {
	it("store calls create the tables from an empty database", async () => {
		// Any store call triggers ensureCapabilityGrantTables; the epoch read
		// is the cheapest probe that the table exists.
		const epoch = await getCapabilityEpoch(store.db);
		expect(epoch).toBe(1);
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "connector.account.read",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "api",
		});
		expect(grant.id).toBeTruthy();
	});
});

describe("capability grant store (real PGlite)", () => {
	it("creates a grant and reads it back", async () => {
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "connector.message.send",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "api",
		});
		expect(grant.subject).toBe(SUBJECT_ENTITY);
		expect(grant.effect).toBe("allow");
		expect(grant.version).toBe(1);
		expect(grant.revokedAt).toBeNull();
		expect(grant.issuer).toBe(ISSUER);
		const fetched = await getCapabilityGrant(store.db, grant.id);
		expect(fetched?.id).toBe(grant.id);
	});

	it("rejects malformed subjects, issuers, capabilities, selectors, effects, provenance", async () => {
		const base = {
			agentId: AGENT,
			worldId: null as UUID | null,
			capability: "connector.message.send",
			resourceSelector: "*",
			effect: "allow" as const,
			issuer: ISSUER,
			provenance: "api" as const,
		};
		await expect(
			createCapabilityGrant(store.db, { ...base, subject: "garbage" }),
		).rejects.toThrow(/subject/);
		await expect(
			createCapabilityGrant(store.db, {
				...base,
				subject: SUBJECT_ENTITY,
				issuer: "nonsense",
			}),
		).rejects.toThrow(/issuer/);
		await expect(
			createCapabilityGrant(store.db, {
				...base,
				subject: SUBJECT_ENTITY,
				capability: "Not A Capability",
			}),
		).rejects.toThrow(/capability/);
		await expect(
			createCapabilityGrant(store.db, {
				...base,
				subject: SUBJECT_ENTITY,
				resourceSelector: "media/*/extra",
			}),
		).rejects.toThrow(/selector/);
		await expect(
			createCapabilityGrant(store.db, {
				...base,
				subject: SUBJECT_ENTITY,
				resourceSelector: "media//",
			}),
		).rejects.toThrow(/selector/);
		await expect(
			createCapabilityGrant(store.db, {
				...base,
				subject: SUBJECT_ENTITY,
				effect: "maybe" as "allow",
			}),
		).rejects.toThrow(/effect/);
		await expect(
			createCapabilityGrant(store.db, {
				...base,
				subject: SUBJECT_ENTITY,
				provenance: "telepathy" as "api",
			}),
		).rejects.toThrow(/provenance/);
	});

	it("expires grants at the boundary: expiresAt <= now never matches", async () => {
		const now = Date.now();
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "media.read",
			resourceSelector: "media/*",
			effect: "allow",
			issuer: ISSUER,
			expiresAt: new Date(now + MINUTE),
			provenance: "api",
		});
		const liveBefore = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "media.read",
			now: now,
		});
		expect(liveBefore.map((g) => g.id)).toContain(grant.id);
		const atBoundary = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "media.read",
			now: now + MINUTE,
		});
		expect(atBoundary.map((g) => g.id)).not.toContain(grant.id);
	});

	it("revocation is visible to the very next live-grant read and bumps the epoch", async () => {
		const epochBefore = await getCapabilityEpoch(store.db);
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "shell.execute",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "settings",
		});
		const epochAfterCreate = await getCapabilityEpoch(store.db);
		expect(epochAfterCreate).toBeGreaterThan(epochBefore);
		const before = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "shell.execute",
		});
		expect(before.map((g) => g.id)).toContain(grant.id);
		const revoked = await revokeCapabilityGrant(store.db, {
			id: grant.id,
			reason: "user revoked",
		});
		expect(revoked.ok).toBe(true);
		if (revoked.ok) {
			expect(revoked.grant.version).toBe(grant.version + 1);
			expect(revoked.grant.revokedAt).not.toBeNull();
		}
		const epochAfterRevoke = await getCapabilityEpoch(store.db);
		expect(epochAfterRevoke).toBeGreaterThan(epochAfterCreate);
		const after = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "shell.execute",
		});
		expect(after.map((g) => g.id)).not.toContain(grant.id);
		// Idempotent revoke returns the already-revoked row.
		const again = await revokeCapabilityGrant(store.db, { id: grant.id });
		expect(again.ok).toBe(true);
	});

	it("update is version-checked and bumps version + epoch", async () => {
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "git.operation",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "natural-language",
		});
		const stale = await updateCapabilityGrant(store.db, {
			id: grant.id,
			expectedVersion: 99,
			patch: { expiresAt: null },
		});
		expect(stale.ok).toBe(false);
		if (!stale.ok) {
			expect(stale.conflict).toBe(true);
		}
		const epochBefore = await getCapabilityEpoch(store.db);
		const good = await updateCapabilityGrant(store.db, {
			id: grant.id,
			expectedVersion: grant.version,
			patch: { expiresAt: new Date(Date.now() + 60 * MINUTE) },
		});
		expect(good.ok).toBe(true);
		if (good.ok) {
			expect(good.grant.version).toBe(grant.version + 1);
			expect(good.grant.expiresAt).not.toBeNull();
		}
		const epochAfter = await getCapabilityEpoch(store.db);
		expect(epochAfter).toBeGreaterThan(epochBefore);
	});

	it("world-scoped grants only match inside their world; global grants match everywhere", async () => {
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: WORLD_1,
			capability: "device.command",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "api",
		});
		const inWorld = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: WORLD_1,
			capability: "device.command",
		});
		expect(inWorld.map((g) => g.id)).toContain(grant.id);
		const otherWorld = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: WORLD_2,
			capability: "device.command",
		});
		expect(otherWorld.map((g) => g.id)).not.toContain(grant.id);
		const global = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "device.command",
			resourceSelector: "home/*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "api",
		});
		const anyWorld = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: WORLD_2,
			capability: "device.command",
		});
		expect(anyWorld.map((g) => g.id)).toContain(global.id);
	});

	it("the partial unique index blocks duplicate active policies", async () => {
		const dup = {
			subject: SUBJECT_ENTITY_2,
			agentId: AGENT,
			worldId: null as UUID | null,
			capability: "api.route.admin",
			resourceSelector: "*",
			effect: "deny" as const,
			issuer: ISSUER,
			provenance: "api" as const,
		};
		const first = await createCapabilityGrant(store.db, dup);
		await expect(createCapabilityGrant(store.db, dup)).rejects.toThrow();
		// Revoking the first frees the policy slot for re-grant.
		await revokeCapabilityGrant(store.db, { id: first.id });
		const third = await createCapabilityGrant(store.db, dup);
		expect(third.id).not.toBe(first.id);
	});

	it("quarantines legacy rows with selectors that no longer canonicalize", async () => {
		// Insert a pre-validation row directly, bypassing the store's guard.
		await store.client.exec(
			`INSERT INTO capabilities.capability_grants (subject, agent_id, capability, resource_selector, effect, issuer, provenance)
			 VALUES ('${SUBJECT_ENTITY}', '${AGENT}', 'coding.environment.use', 'env:local//bad', 'allow', '${ISSUER}', 'api')`,
		);
		const live = await listLiveGrantsFor(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "coding.environment.use",
		});
		// The quarantined row is visible for management via getCapabilityGrant
		// only through the store's own reads; live-grant listing must exclude it.
		expect(live.some((g) => g.resourceSelector === "env:local//bad")).toBe(
			false,
		);
		const result = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "coding.environment.use",
			resource: "env:local//bad",
		});
		expect(result.decision).toBe("deny");
	});
});

describe("authorizeCapability decision semantics (real PGlite)", () => {
	it("allows via matching live allow grants and writes an audit row", async () => {
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "connector.message.send",
			resourceSelector: "channel:general/*",
			effect: "allow",
			issuer: ISSUER,
			constraints: { maxMessagesPerMinute: 10 },
			provenance: "api",
		});
		const result = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "connector.message.send",
			resource: "channel:general/msg-1",
		});
		expect(result.decision).toBe("allow");
		expect(result.reasonCode).toBe(CAPABILITY_REASON_CODES.ALLOW_GRANT_MATCHED);
		expect(result.matchedGrantId).toBe(grant.id);
		expect(result.constraints).toEqual({ maxMessagesPerMinute: 10 });
		expect(result.layer).toBe("allow-grant");
		const audit = await listCapabilityAudit(store.db, { limit: 100 });
		const row = audit.find((row) => row.id === result.auditId);
		expect(row).toBeDefined();
		expect(row?.decision).toBe("allow");
		expect(row?.matchedGrantId).toBe(grant.id);
		expect(row?.grantVersion).toBe(grant.version);
	});

	it("deny-wins: a simultaneous explicit deny outranks the allow", async () => {
		const allow = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "filesystem.write",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "api",
		});
		const deny = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "filesystem.write",
			resourceSelector: "secrets/*",
			effect: "deny",
			issuer: ISSUER,
			provenance: "api",
		});
		const okResult = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "filesystem.write",
			resource: "notes/todo.md",
		});
		expect(okResult.decision).toBe("allow");
		const denied = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "filesystem.write",
			resource: "secrets/private-key.pem",
		});
		expect(denied.decision).toBe("deny");
		expect(denied.reasonCode).toBe(CAPABILITY_REASON_CODES.DENY_GRANT_MATCHED);
		expect(denied.matchedGrantId).toBe(deny.id);
		expect(denied.layer).toBe("deny-grant");
		expect(allow.id).not.toBe(deny.id);
	});

	it("revocation is effective before the next authorize returns", async () => {
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "provider.model.invoke",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			provenance: "api",
		});
		const before = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "provider.model.invoke",
			resource: "model:glm",
		});
		expect(before.decision).toBe("allow");
		const revoked = await revokeCapabilityGrant(store.db, {
			id: grant.id,
			reason: "rotation",
		});
		expect(revoked.ok).toBe(true);
		const after = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "provider.model.invoke",
			resource: "model:glm",
		});
		expect(after.decision).toBe("deny");
		expect(after.reasonCode).toBe(CAPABILITY_REASON_CODES.NO_MATCHING_GRANT);
	});

	it("fails closed on malformed requests with audit rows", async () => {
		const badSubject = await authorizeCapability(store.db, {
			subject: "not-a-subject",
			agentId: AGENT,
			capability: "media.read",
			resource: "media/abc",
		});
		expect(badSubject.decision).toBe("deny");
		expect(badSubject.reasonCode).toBe(CAPABILITY_REASON_CODES.INVALID_REQUEST);
		const badCapability = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "NOPE",
			resource: "media/abc",
		});
		expect(badCapability.reasonCode).toBe(
			CAPABILITY_REASON_CODES.INVALID_REQUEST,
		);
		const badAgent = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: "zzz" as UUID,
			capability: "media.read",
			resource: "media/abc",
		});
		expect(badAgent.reasonCode).toBe(CAPABILITY_REASON_CODES.INVALID_REQUEST);
		const audit = await listCapabilityAudit(store.db, { limit: 200 });
		for (const result of [badSubject, badCapability, badAgent]) {
			const row = audit.find((row) => row.id === result.auditId);
			expect(row).toBeDefined();
			expect(row?.decision).toBe("deny");
			expect(row?.reasonCode).toBe(CAPABILITY_REASON_CODES.INVALID_REQUEST);
		}
	});

	it("no matching grant denies (no implicit allow)", async () => {
		const result = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "coding.environment.use",
			resource: "env:local",
		});
		expect(result.decision).toBe("deny");
		expect(result.reasonCode).toBe(CAPABILITY_REASON_CODES.NO_MATCHING_GRANT);
		expect(result.layer).toBe("no-match");
	});

	it("expired grants never authorize even mid-window", async () => {
		const grant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			worldId: null,
			capability: "api.route.admin",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			expiresAt: new Date(Date.now() + 5 * MINUTE),
			provenance: "api",
		});
		const before = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "api.route.admin",
			resource: "route:/api/settings",
			now: Date.now() + MINUTE,
		});
		expect(before.decision).toBe("allow");
		const after = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY,
			agentId: AGENT,
			capability: "api.route.admin",
			resource: "route:/api/settings",
			now: Date.now() + 10 * MINUTE,
		});
		expect(after.decision).toBe("deny");
		expect(grant.expiresAt).not.toBeNull();
	});

	it("intersects constraints across matching allows; incompatibility denies", async () => {
		// Two overlapping canonical allows on the same resource: numeric mins
		// intersect to the smaller (most-restrictive) value. Distinct subjects
		// from every other test so the partial unique active-policy index
		// (subject, agent, capability, selector, effect) sees fresh rows.
		const constraintSubject = "entity:00000000-0000-4000-8000-00000000e701";
		const a = await createCapabilityGrant(store.db, {
			subject: constraintSubject,
			agentId: AGENT,
			worldId: null,
			capability: "connector.message.send",
			resourceSelector: "channel:hot/*",
			effect: "allow",
			issuer: ISSUER,
			constraints: { maxMessagesPerMinute: 30 },
			provenance: "api",
		});
		const b = await createCapabilityGrant(store.db, {
			subject: constraintSubject,
			agentId: AGENT,
			worldId: null,
			capability: "connector.message.send",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			constraints: { maxMessagesPerMinute: 5 },
			provenance: "api",
		});
		const result = await authorizeCapability(store.db, {
			subject: constraintSubject,
			agentId: AGENT,
			capability: "connector.message.send",
			resource: "channel:hot/x",
		});
		expect(result.decision).toBe("allow");
		expect(result.constraints).toEqual({ maxMessagesPerMinute: 5 });
		expect(a.id).not.toBe(b.id);
		// Incompatible scalar values for the same key deny.
		const conflictSubject = "entity:00000000-0000-4000-8000-00000000e702";
		const c1 = await createCapabilityGrant(store.db, {
			subject: conflictSubject,
			agentId: AGENT,
			worldId: null,
			capability: "media.write",
			resourceSelector: "media/*",
			effect: "allow",
			issuer: ISSUER,
			constraints: { visibility: "private" },
			provenance: "api",
		});
		const c2 = await createCapabilityGrant(store.db, {
			subject: conflictSubject,
			agentId: AGENT,
			worldId: null,
			capability: "media.write",
			resourceSelector: "*",
			effect: "allow",
			issuer: ISSUER,
			constraints: { visibility: "public" },
			provenance: "api",
		});
		const conflicted = await authorizeCapability(store.db, {
			subject: conflictSubject,
			agentId: AGENT,
			capability: "media.write",
			resource: "media/abc",
		});
		expect(conflicted.decision).toBe("deny");
		expect(conflicted.reasonCode).toBe(
			CAPABILITY_REASON_CODES.INCOMPATIBLE_CONSTRAINTS,
		);
		expect(c1.id).not.toBe(c2.id);
	});

	it("role tier evaluates after grants and cannot rescue a deny grant", async () => {
		const denyGrant = await createCapabilityGrant(store.db, {
			subject: SUBJECT_ENTITY_2,
			agentId: AGENT,
			worldId: null,
			capability: "device.command",
			resourceSelector: "danger/*",
			effect: "deny",
			issuer: ISSUER,
			provenance: "api",
		});
		const resolverCalls: string[] = [];
		const result = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY_2,
			agentId: AGENT,
			capability: "device.command",
			resource: "danger/nuke",
			roleResolver: async (subject) => {
				resolverCalls.push(subject);
				return ["admin"];
			},
		});
		expect(result.decision).toBe("deny");
		expect(result.reasonCode).toBe(CAPABILITY_REASON_CODES.DENY_GRANT_MATCHED);
		// The deny grant short-circuited before the role tier ran.
		expect(resolverCalls).toEqual([]);
		expect(denyGrant.id).toBeTruthy();
		// No-grant case: the resolver runs and the layer names it.
		const noGrant = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY_2,
			agentId: AGENT,
			capability: "device.command",
			resource: "danger2/other",
			roleResolver: async () => ["member"],
		});
		expect(noGrant.decision).toBe("deny");
		expect(noGrant.layer).toBe("role-tier");
		// A throwing resolver degrades to no-match, never widens access.
		const broken = await authorizeCapability(store.db, {
			subject: SUBJECT_ENTITY_2,
			agentId: AGENT,
			capability: "device.command",
			resource: "danger3/x",
			roleResolver: async () => {
				throw new Error("resolver down");
			},
		});
		expect(broken.decision).toBe("deny");
		expect(broken.reasonCode).toBe(CAPABILITY_REASON_CODES.NO_MATCHING_GRANT);
	});
});

describe("selector + subject + capability canonicalization", () => {
	it("selector matching follows prefix and exact semantics", () => {
		expect(selectorMatchesResource("media/*", "media/abc")).toBe(true);
		expect(selectorMatchesResource("media/*", "media/abc/def")).toBe(true);
		expect(selectorMatchesResource("media/*", "mediaroot")).toBe(false);
		expect(selectorMatchesResource("media/*", "media")).toBe(false);
		expect(selectorMatchesResource("*", "anything")).toBe(true);
		expect(selectorMatchesResource("exact:one", "exact:one")).toBe(true);
		expect(selectorMatchesResource("exact:one", "exact:two")).toBe(false);
	});

	it("subject canonicalization validates kinds and uuids", () => {
		expect(canonicalizeCapabilitySubject(SUBJECT_ENTITY).ok).toBe(true);
		expect(canonicalizeCapabilitySubject("entity:not-a-uuid").ok).toBe(false);
		expect(canonicalizeCapabilitySubject("role:admin").ok).toBe(true);
		const up = canonicalizeCapabilitySubject(
			"entity:00000000-0000-4000-8000-00000000C444",
		);
		expect(up.ok && up.subject).toBe(SUBJECT_ENTITY);
		expect(canonicalizeCapabilitySubject("cosmic:abc").ok).toBe(false);
		expect(canonicalizeCapabilitySubject("").ok).toBe(false);
	});

	it("capability names must be dot-separated lowercase", () => {
		expect(validateCapabilityName("connector.message.send").ok).toBe(true);
		expect(validateCapabilityName("send").ok).toBe(false);
		expect(validateCapabilityName("Connector.Message").ok).toBe(false);
		expect(validateCapabilityName("conn..send").ok).toBe(false);
		expect(validateCapabilityName("conn .send").ok).toBe(false);
	});

	it("selectors canonicalize wildcards strictly", () => {
		expect(canonicalizeResourceSelector("*").ok).toBe(true);
		expect(canonicalizeResourceSelector("media/*").ok).toBe(true);
		expect(canonicalizeResourceSelector("media//").ok).toBe(false);
		expect(canonicalizeResourceSelector("*media").ok).toBe(false);
		expect(canonicalizeResourceSelector("me*dia/x").ok).toBe(false);
		expect(canonicalizeResourceSelector(`${"a".repeat(513)}/*`).ok).toBe(false);
	});
});

describe("restart survival (real PGlite, disk data dir)", () => {
	it("grants created in one process are authoritative after close + reopen", async () => {
		const restartDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "capgrants-restart-"),
		);
		try {
			const first = await openStore(restartDir);
			const grant = await createCapabilityGrant(first.db, {
				subject: SUBJECT_ENTITY,
				agentId: AGENT,
				worldId: WORLD_1,
				capability: "connector.message.send",
				resourceSelector: "*",
				effect: "allow",
				issuer: ISSUER,
				constraints: { survives: true },
				provenance: "settings",
			});
			const denyGrant = await createCapabilityGrant(first.db, {
				subject: SUBJECT_ENTITY,
				agentId: AGENT,
				worldId: WORLD_1,
				capability: "connector.message.send",
				resourceSelector: "channel:spam/*",
				effect: "deny",
				issuer: ISSUER,
				provenance: "settings",
			});
			const epochFirst = await getCapabilityEpoch(first.db);
			await first.close();

			const second = await openStore(restartDir);
			const live = await listLiveGrantsFor(second.db, {
				subject: SUBJECT_ENTITY,
				agentId: AGENT,
				worldId: WORLD_1,
				capability: "connector.message.send",
			});
			expect(live.map((g) => g.id)).toContain(grant.id);
			expect(live.map((g) => g.id)).toContain(denyGrant.id);
			const epochSecond = await getCapabilityEpoch(second.db);
			expect(epochSecond).toBe(epochFirst);
			const allowed = await authorizeCapability(second.db, {
				subject: SUBJECT_ENTITY,
				agentId: AGENT,
				worldId: WORLD_1,
				capability: "connector.message.send",
				resource: "channel:general/x",
			});
			expect(allowed.decision).toBe("allow");
			expect(allowed.constraints).toEqual({ survives: true });
			const denied = await authorizeCapability(second.db, {
				subject: SUBJECT_ENTITY,
				agentId: AGENT,
				worldId: WORLD_1,
				capability: "connector.message.send",
				resource: "channel:spam/y",
			});
			expect(denied.decision).toBe("deny");
			expect(denied.reasonCode).toBe(
				CAPABILITY_REASON_CODES.DENY_GRANT_MATCHED,
			);
			await second.close();
		} finally {
			fs.rmSync(restartDir, { recursive: true, force: true });
		}
	}, 180_000);
});

describe("enforcement inventory", () => {
	it("every boundary id is a valid capability name and status is classified", () => {
		expect(CAPABILITY_BOUNDARY_INVENTORY.length).toBeGreaterThanOrEqual(12);
		for (const entry of CAPABILITY_BOUNDARY_INVENTORY) {
			const capability = validateCapabilityName(entry.id);
			expect({ id: entry.id, ok: capability.ok }).toEqual({
				id: entry.id,
				ok: true,
			});
			expect(
				["enforced", "inventory-only", "planned"].includes(entry.status),
			).toBe(true);
			expect(typeof entry.description).toBe("string");
			expect(entry.description.length).toBeGreaterThan(10);
		}
	});
});
