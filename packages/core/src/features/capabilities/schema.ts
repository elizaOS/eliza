/**
 * Drizzle table definitions for the durable capability-grant feature
 * (#23102), in a dedicated `capabilities` Postgres schema — authorization
 * data kept out of the trust feature so enforcement boundaries never reach
 * sideways into trust tables. `ensureCapabilityGrantTables` materializes
 * both tables with idempotent raw DDL at first store use (the
 * TrajectoriesService pattern), because nothing in the runtime registers a
 * schema-bearing trust plugin and relying on plugin-schema migration would
 * leave these tables uncreated in real deployments.
 */

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgSchema,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export const capabilitiesSchema = pgSchema("capabilities");

/**
 * Durable per-principal capability grants. Each row is one subject ×
 * capability × resource-selector policy with allow/deny effect, issuer
 * provenance, expiry, revocation, constraints, and an optimistic-concurrency
 * version. A partial unique index (world-aware via nil-uuid coalescing)
 * enforces one active row per exact policy per world; superseding a policy
 * revokes the old row first.
 */
export const capabilityGrants = capabilitiesSchema.table(
	"capability_grants",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		/** Canonical subject string, e.g. `entity:<uuid>` or `role:admin`. */
		subject: text("subject").notNull(),
		/** The agent whose authority this grant applies under. */
		agentId: uuid("agent_id").notNull(),
		/** Optional world scoping; null grants apply in every world. */
		worldId: uuid("world_id"),
		/** Typed capability name, e.g. `connector.message.send`. */
		capability: text("capability").notNull(),
		/**
		 * Resource selector: `*`, an exact resource id, or `<prefix>/*` matching
		 * the prefix's descendants at any depth.
		 */
		resourceSelector: text("resource_selector").notNull(),
		/** 'allow' | 'deny'; an explicit deny outranks any allow. */
		effect: text("effect").notNull(),
		/** Canonical issuer subject string, e.g. `entity:<uuid>`. */
		issuer: text("issuer").notNull(),
		issuedAt: timestamp("issued_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		/** Null expires never. */
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		/** Null means not revoked; set by revoke(). */
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		revocationReason: text("revocation_reason"),
		/** Free-form constraints surfaced (intersected) on allow decisions. */
		constraints: jsonb("constraints").default({}),
		/** Where this grant came from: 'api' | 'natural-language' | 'settings'. */
		provenance: text("provenance").notNull(),
		/** Optimistic-concurrency version, bumped on every mutation. */
		version: integer("version").default(1).notNull(),
	},
	(table) => [
		index("capability_grants_subject_idx").on(table.subject),
		index("capability_grants_agent_idx").on(table.agentId),
		index("capability_grants_capability_idx").on(table.capability),
		uniqueIndex("capability_grants_active_uniq")
			.on(
				table.subject,
				table.agentId,
				// Null (global) world coalesces to the nil uuid so global and
				// world-scoped rows never collide in the unique index.
				sql`coalesce(${table.worldId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
				table.capability,
				table.resourceSelector,
				table.effect,
			)
			.where(sql`revoked_at IS NULL`),
	],
);

/**
 * Append-only audit trail for capability authorization decisions. Every
 * `authorizeCapability` call — allow or deny — attempts exactly one row
 * carrying the decision's audit id so denials are as traceable as grants.
 * Audits carry ids and outcomes only — never credentials, prompts, message
 * bodies, or file bytes (#23102 acceptance criterion 8).
 */
export const capabilityAuditLog = capabilitiesSchema.table(
	"capability_audit_log",
	{
		id: uuid("id").primaryKey(),
		agentId: uuid("agent_id").notNull(),
		subject: text("subject").notNull(),
		capability: text("capability").notNull(),
		/** Resource id, truncated; identifies the target, never its contents. */
		resource: text("resource").notNull(),
		decision: text("decision").notNull(), // 'allow' | 'deny'
		/** Machine-readable denial/deny-wins reason code. */
		reasonCode: text("reason_code").notNull(),
		/** Human-readable explanation. */
		details: text("details"),
		/** Grant the decision matched; null when nothing matched. */
		matchedGrantId: uuid("matched_grant_id"),
		/** Intersected grant constraints echoed on allow decisions. */
		constraints: jsonb("constraints"),
		/** Matched grant expiry echoed when the decision matched a live grant. */
		grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
		/** True when the request must be re-run through an approval flow. */
		approvalRequired: boolean("approval_required").default(false).notNull(),
		/** Matched grant version at decision time. */
		grantVersion: integer("grant_version"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("capability_audit_subject_idx").on(table.subject),
		index("capability_audit_created_idx").on(table.createdAt),
	],
);

/**
 * Single-row revocation epoch (RP Q4): every grant mutation bumps
 * `capability_epoch`, and any future decision cache must record the epoch it
 * read; a mismatch is a cache miss. Slice 1 ships no cache — revocation is
 * effective before return by construction (one indexed read per decision) —
 * but the epoch is part of the store API from day one so the first cache
 * implementation cannot reintroduce the stale-allow bug.
 */
export const capabilityEpoch = capabilitiesSchema.table("capability_epoch", {
	/** Fixed row id; only row 1 exists. */
	id: integer("id").primaryKey().default(1),
	/** Monotonic counter bumped on every grant create/revoke/update. */
	epoch: integer("epoch").default(1).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});
