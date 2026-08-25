/**
 * Data-access layer for durable per-principal capability grants (#23102).
 * Wraps the `capabilities` schema tables: validated insert, version-checked
 * update and revoke (both bump the global `capability_epoch` and the row's
 * `version`), live-grant lookup that filters expired and revoked rows in
 * SQL, and the append-only audit append used by `authorizeCapability`.
 * `ensureCapabilityGrantTables` self-migrates with idempotent DDL on first
 * use per process (TrajectoriesService pattern), so the tables exist
 * whenever any SQL database is attached — no plugin registration needed.
 * Reads through `listLiveGrantsFor` are authoritative; a revocation is
 * visible to the very next decision because there is no decision cache.
 */

import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { UUID } from "../../types/index.ts";
import {
	capabilityAuditLog,
	capabilityEpoch,
	capabilityGrants,
} from "./schema.ts";
import type {
	CapabilityGrant,
	CreateCapabilityGrantInput,
	UpdateCapabilityGrantInput,
} from "./types.ts";
import {
	canonicalizeCapabilitySubject,
	canonicalizeResourceSelector,
	parseCapabilityGrantEffect,
	parseCapabilityProvenance,
	truncateAuditResource,
	validateCapabilityName,
} from "./types.ts";

/** Row shape as Drizzle returns it (dates as Date, jsonb as unknown). */
type GrantRow = {
	id: string;
	subject: string;
	agentId: string;
	worldId: string | null;
	capability: string;
	resourceSelector: string;
	effect: string;
	issuer: string;
	issuedAt: Date;
	expiresAt: Date | null;
	revokedAt: Date | null;
	revocationReason: string | null;
	constraints: unknown;
	provenance: string;
	version: number;
};

/**
 * Rejects rows whose enum-like columns drifted out of vocabulary, and
 * quarantines rows whose selector pre-dates strict validation: a selector
 * that no longer canonicalizes never matches (the grant stays visible for
 * management but stops authorizing).
 */
function rowToGrant(row: GrantRow): CapabilityGrant | null {
	const effect = parseCapabilityGrantEffect(row.effect);
	const provenance = parseCapabilityProvenance(row.provenance);
	if (effect === null || provenance === null) {
		return null;
	}
	const constraints =
		row.constraints !== null &&
		typeof row.constraints === "object" &&
		!Array.isArray(row.constraints)
			? (row.constraints as Record<string, unknown>)
			: null;
	return {
		id: row.id as UUID,
		subject: row.subject,
		agentId: row.agentId as UUID,
		worldId: (row.worldId as UUID | null) ?? null,
		capability: row.capability,
		resourceSelector: row.resourceSelector,
		effect,
		issuer: row.issuer,
		issuedAt: row.issuedAt,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		revocationReason: row.revocationReason,
		constraints,
		provenance,
		version: row.version,
	};
}

/** True when the row's selector still passes canonicalization. */
function selectorIsTrusted(grant: CapabilityGrant): boolean {
	return canonicalizeResourceSelector(grant.resourceSelector).ok;
}

/**
 * Idempotent DDL materializing the capability tables. Runs once per process
 * per database handle (memoized by the client identity); safe to call
 * concurrently because every statement is IF NOT EXISTS.
 */
const CAPABILITY_DDL = [
	`CREATE SCHEMA IF NOT EXISTS capabilities`,
	`CREATE TABLE IF NOT EXISTS capabilities.capability_grants (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		subject text NOT NULL,
		agent_id uuid NOT NULL,
		world_id uuid,
		capability text NOT NULL,
		resource_selector text NOT NULL,
		effect text NOT NULL CHECK (effect IN ('allow','deny')),
		issuer text NOT NULL,
		issued_at timestamptz DEFAULT now() NOT NULL,
		expires_at timestamptz,
		revoked_at timestamptz,
		revocation_reason text,
		constraints jsonb DEFAULT '{}'::jsonb,
		provenance text NOT NULL CHECK (provenance IN ('api','natural-language','settings')),
		version integer DEFAULT 1 NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS capability_grants_subject_idx ON capabilities.capability_grants (subject)`,
	`CREATE INDEX IF NOT EXISTS capability_grants_agent_idx ON capabilities.capability_grants (agent_id)`,
	`CREATE INDEX IF NOT EXISTS capability_grants_capability_idx ON capabilities.capability_grants (capability)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS capability_grants_active_uniq ON capabilities.capability_grants (subject, agent_id, capability, resource_selector, effect) WHERE revoked_at IS NULL`,
	`CREATE TABLE IF NOT EXISTS capabilities.capability_audit_log (
		id uuid PRIMARY KEY,
		agent_id uuid NOT NULL,
		subject text NOT NULL,
		capability text NOT NULL,
		resource text NOT NULL,
		decision text NOT NULL CHECK (decision IN ('allow','deny')),
		reason_code text NOT NULL,
		details text,
		matched_grant_id uuid,
		constraints jsonb,
		grant_expires_at timestamptz,
		approval_required boolean DEFAULT false NOT NULL,
		grant_version integer,
		created_at timestamptz DEFAULT now() NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS capability_audit_subject_idx ON capabilities.capability_audit_log (subject)`,
	`CREATE INDEX IF NOT EXISTS capability_audit_created_idx ON capabilities.capability_audit_log (created_at)`,
	`CREATE TABLE IF NOT EXISTS capabilities.capability_epoch (
		id integer PRIMARY KEY DEFAULT 1,
		epoch integer DEFAULT 1 NOT NULL,
		updated_at timestamptz DEFAULT now() NOT NULL
	)`,
	`INSERT INTO capabilities.capability_epoch (id, epoch) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`,
];

const ensuredClients = new WeakSet<object>();

/**
 * Minimal Drizzle-compatible DB shape this store uses. Mirrors the trust
 * feature's `DrizzleDB`: a chainable any-typed query-builder surface plus the
 * raw `execute` used by the idempotent DDL bootstrap.
 */
export interface CapabilityStoreDb {
	// biome-ignore lint/suspicious/noExplicitAny: raw execute result varies by driver (rows/rowCount); consumers treat it as opaque
	execute(query: unknown): Promise<any>;
	// biome-ignore lint/suspicious/noExplicitAny: chainable drizzle builder
	select: (...args: any[]) => any;
	// biome-ignore lint/suspicious/noExplicitAny: chainable drizzle builder
	insert: (table: any) => any;
	// biome-ignore lint/suspicious/noExplicitAny: chainable drizzle builder
	update: (table: any) => any;
}

/**
 * Ensures the capability tables exist on the attached database. Memoized per
 * client object so repeated calls are one WeakSet lookup.
 */
export async function ensureCapabilityGrantTables(
	db: CapabilityStoreDb,
	client?: object,
): Promise<void> {
	const key = client ?? (db as unknown as object);
	if (ensuredClients.has(key)) {
		return;
	}
	for (const statement of CAPABILITY_DDL) {
		await db.execute(sql.raw(statement));
	}
	ensuredClients.add(key);
}

/** Reads the current revocation epoch (cache-invalidation watermark). */
export async function getCapabilityEpoch(
	db: CapabilityStoreDb,
): Promise<number> {
	await ensureCapabilityGrantTables(db);
	const rows = (await db
		.select()
		.from(capabilityEpoch)
		.where(eq(capabilityEpoch.id, 1))
		.limit(1)) as Array<{ epoch: number }>;
	return rows[0]?.epoch ?? 1;
}

/** Bumps the revocation epoch; every grant mutation calls this. */
async function bumpEpoch(db: CapabilityStoreDb): Promise<void> {
	await db
		.update(capabilityEpoch)
		.set({ epoch: sql`${capabilityEpoch.epoch} + 1`, updatedAt: new Date() })
		.where(eq(capabilityEpoch.id, 1));
}

export type RevokeGrantResult =
	| { ok: true; grant: CapabilityGrant }
	| { ok: false; error: string };

export type UpdateGrantResult =
	| { ok: true; grant: CapabilityGrant }
	| { ok: false; error: string; conflict?: true; grant?: CapabilityGrant };

export interface AuditAppendInput {
	auditId: UUID;
	agentId: UUID;
	subject: string;
	capability: string;
	resource: string;
	decision: "allow" | "deny";
	reasonCode: string;
	details?: string | null;
	matchedGrantId?: UUID | null;
	constraints?: Record<string, unknown> | null;
	grantExpiresAt?: Date | null;
	approvalRequired?: boolean;
	grantVersion?: number | null;
}

export interface AuditRow {
	id: UUID;
	agentId: UUID;
	subject: string;
	capability: string;
	resource: string;
	decision: string;
	reasonCode: string;
	details: string | null;
	matchedGrantId: UUID | null;
	grantExpiresAt: Date | null;
	approvalRequired: boolean;
	grantVersion: number | null;
	createdAt: Date;
}

/** Creates a durable grant after validating every vocabulary field. */
export async function createCapabilityGrant(
	db: CapabilityStoreDb,
	input: CreateCapabilityGrantInput,
): Promise<CapabilityGrant> {
	await ensureCapabilityGrantTables(db);
	const subject = canonicalizeCapabilitySubject(input.subject);
	if (!subject.ok) {
		throw new Error(`[capability-grants] ${subject.error}`);
	}
	const issuer = canonicalizeCapabilitySubject(input.issuer);
	if (!issuer.ok) {
		throw new Error(`[capability-grants] issuer: ${issuer.error}`);
	}
	const capability = validateCapabilityName(input.capability);
	if (!capability.ok) {
		throw new Error(`[capability-grants] ${capability.error}`);
	}
	const selector = canonicalizeResourceSelector(input.resourceSelector);
	if (!selector.ok) {
		throw new Error(`[capability-grants] ${selector.error}`);
	}
	if (input.effect !== "allow" && input.effect !== "deny") {
		throw new Error(
			`[capability-grants] effect must be "allow" or "deny", got ${JSON.stringify(input.effect)}`,
		);
	}
	if (parseCapabilityProvenance(input.provenance) === null) {
		throw new Error(
			`[capability-grants] unknown provenance ${JSON.stringify(input.provenance)}`,
		);
	}

	const inserted = (await db
		.insert(capabilityGrants)
		.values({
			subject: subject.subject,
			agentId: input.agentId,
			worldId: input.worldId ?? null,
			capability: capability.capability,
			resourceSelector: selector.selector,
			effect: input.effect,
			issuer: issuer.subject,
			expiresAt: input.expiresAt ?? null,
			constraints: input.constraints ?? {},
			provenance: input.provenance,
		})
		.returning()) as GrantRow[];
	const row = inserted[0];
	if (!row) {
		throw new Error(
			"[capability-grants] insert returned no row (store misbehavior)",
		);
	}
	const grant = rowToGrant(row);
	if (!grant) {
		throw new Error(
			`[capability-grants] inserted row failed vocabulary re-parse: ${JSON.stringify({ effect: row.effect, provenance: row.provenance })}`,
		);
	}
	await bumpEpoch(db);
	return grant;
}

/**
 * Live grants for a subject × capability, ordered newest-issued first.
 * Expired (expiresAt <= now) and revoked rows are excluded in SQL; rows with
 * selectors that no longer canonicalize are quarantined after the read
 * (visible for management, never authoritative).
 */
export async function listLiveGrantsFor(
	db: CapabilityStoreDb,
	params: {
		subject: string;
		agentId: UUID;
		worldId?: UUID | null;
		capability: string;
		now?: number;
	},
): Promise<CapabilityGrant[]> {
	await ensureCapabilityGrantTables(db);
	const now = new Date(params.now ?? Date.now());
	const worldMatch = or(
		isNull(capabilityGrants.worldId),
		params.worldId !== undefined && params.worldId !== null
			? eq(capabilityGrants.worldId, params.worldId)
			: sql`false`,
	);
	const rows = (await db
		.select()
		.from(capabilityGrants)
		.where(
			and(
				eq(capabilityGrants.subject, params.subject),
				eq(capabilityGrants.agentId, params.agentId),
				eq(capabilityGrants.capability, params.capability),
				worldMatch,
				isNull(capabilityGrants.revokedAt),
				or(
					isNull(capabilityGrants.expiresAt),
					gt(capabilityGrants.expiresAt, now),
				),
			),
		)
		.orderBy(desc(capabilityGrants.issuedAt), desc(capabilityGrants.id))
		.limit(500)) as GrantRow[];
	return rows
		.map(rowToGrant)
		.filter((grant): grant is CapabilityGrant => grant !== null)
		.filter((grant) => selectorIsTrusted(grant));
}

/** Version-checked update of expiry/constraints; bumps `version` + epoch. */
export async function updateCapabilityGrant(
	db: CapabilityStoreDb,
	input: UpdateCapabilityGrantInput,
): Promise<UpdateGrantResult> {
	await ensureCapabilityGrantTables(db);
	const patch: Record<string, unknown> = {};
	if (Object.hasOwn(input.patch, "expiresAt")) {
		patch.expiresAt = input.patch.expiresAt ?? null;
	}
	if (Object.hasOwn(input.patch, "constraints")) {
		patch.constraints = input.patch.constraints ?? {};
	}
	if (Object.keys(patch).length === 0) {
		return {
			ok: false,
			error: "[capability-grants] update patch must set at least one field",
		};
	}
	const updated = (await db
		.update(capabilityGrants)
		.set({
			...patch,
			version: sql`${capabilityGrants.version} + 1`,
		})
		.where(
			and(
				eq(capabilityGrants.id, input.id),
				eq(capabilityGrants.version, input.expectedVersion),
			),
		)
		.returning()) as GrantRow[];
	const row = updated[0];
	if (!row) {
		const existing = (await db
			.select()
			.from(capabilityGrants)
			.where(eq(capabilityGrants.id, input.id))
			.limit(1)) as GrantRow[];
		if (!existing[0]) {
			return {
				ok: false,
				error: `[capability-grants] grant ${input.id} not found`,
			};
		}
		const current = rowToGrant(existing[0]);
		return {
			ok: false,
			error: `[capability-grants] version conflict on ${input.id}: expected ${input.expectedVersion}, current ${existing[0].version}`,
			conflict: true,
			grant: current ?? undefined,
		};
	}
	const grant = rowToGrant(row);
	if (!grant) {
		return {
			ok: false,
			error: "[capability-grants] updated row failed vocabulary re-parse",
		};
	}
	await bumpEpoch(db);
	return { ok: true, grant };
}

/**
 * Revokes a grant: sets revokedAt/reason and bumps `version` + the global
 * epoch. Idempotent for an already-revoked grant (returns it unchanged).
 * The next `listLiveGrantsFor` after this returns cannot include the
 * revoked row.
 */
export async function revokeCapabilityGrant(
	db: CapabilityStoreDb,
	params: { id: UUID; reason?: string; now?: number },
): Promise<RevokeGrantResult> {
	await ensureCapabilityGrantTables(db);
	const revokedAt = new Date(params.now ?? Date.now());
	const updated = (await db
		.update(capabilityGrants)
		.set({
			revokedAt,
			revocationReason: params.reason ?? null,
			version: sql`${capabilityGrants.version} + 1`,
		})
		.where(
			and(
				eq(capabilityGrants.id, params.id),
				isNull(capabilityGrants.revokedAt),
			),
		)
		.returning()) as GrantRow[];
	const row = updated[0];
	if (!row) {
		const existing = (await db
			.select()
			.from(capabilityGrants)
			.where(eq(capabilityGrants.id, params.id))
			.limit(1)) as GrantRow[];
		if (!existing[0]) {
			return {
				ok: false,
				error: `[capability-grants] grant ${params.id} not found`,
			};
		}
		const already = rowToGrant(existing[0]);
		if (already && already.revokedAt !== null) {
			return { ok: true, grant: already };
		}
		return {
			ok: false,
			error: `[capability-grants] revoke of ${params.id} matched no row and row is not revoked`,
		};
	}
	const grant = rowToGrant(row);
	if (!grant) {
		return {
			ok: false,
			error: "[capability-grants] revoked row failed vocabulary re-parse",
		};
	}
	await bumpEpoch(db);
	return { ok: true, grant };
}

/** Fetch one grant by id (any state) for management surfaces. */
export async function getCapabilityGrant(
	db: CapabilityStoreDb,
	id: UUID,
): Promise<CapabilityGrant | null> {
	await ensureCapabilityGrantTables(db);
	const rows = (await db
		.select()
		.from(capabilityGrants)
		.where(eq(capabilityGrants.id, id))
		.limit(1)) as GrantRow[];
	const row = rows[0];
	if (!row) return null;
	return rowToGrant(row);
}

/** Appends one audit row; every authorizeCapability decision writes one. */
export async function appendCapabilityAudit(
	db: CapabilityStoreDb,
	input: AuditAppendInput,
): Promise<void> {
	await ensureCapabilityGrantTables(db);
	await db.insert(capabilityAuditLog).values({
		id: input.auditId,
		agentId: input.agentId,
		subject: input.subject,
		capability: input.capability,
		resource: truncateAuditResource(input.resource),
		decision: input.decision,
		reasonCode: input.reasonCode,
		details: input.details ?? null,
		matchedGrantId: input.matchedGrantId ?? null,
		constraints: input.constraints ?? null,
		grantExpiresAt: input.grantExpiresAt ?? null,
		approvalRequired: input.approvalRequired ?? false,
		grantVersion: input.grantVersion ?? null,
	});
}

/** Lists audit rows newest-first, optionally narrowed by subject. */
export async function listCapabilityAudit(
	db: CapabilityStoreDb,
	params?: { subject?: string; limit?: number },
): Promise<AuditRow[]> {
	await ensureCapabilityGrantTables(db);
	const rows = (await db
		.select()
		.from(capabilityAuditLog)
		.where(
			params?.subject
				? eq(capabilityAuditLog.subject, params.subject)
				: undefined,
		)
		.orderBy(desc(capabilityAuditLog.createdAt), desc(capabilityAuditLog.id))
		.limit(Math.min(params?.limit ?? 100, 500))) as Array<{
		id: string;
		agentId: string;
		subject: string;
		capability: string;
		resource: string;
		decision: string;
		reasonCode: string;
		details: string | null;
		matchedGrantId: string | null;
		constraints: unknown;
		grantExpiresAt: Date | null;
		approvalRequired: boolean;
		grantVersion: number | null;
		createdAt: Date;
	}>;
	return rows.map((row) => ({
		id: row.id as UUID,
		agentId: row.agentId as UUID,
		subject: row.subject,
		capability: row.capability,
		resource: row.resource,
		decision: row.decision,
		reasonCode: row.reasonCode,
		details: row.details,
		matchedGrantId: (row.matchedGrantId as UUID | null) ?? null,
		grantExpiresAt: row.grantExpiresAt,
		approvalRequired: row.approvalRequired,
		grantVersion: row.grantVersion,
		createdAt: row.createdAt,
	}));
}
