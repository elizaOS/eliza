/**
 * Real-PGLite coverage for the SecurityStore data-access layer: incident
 * insert defaults, recency/room filtering with the 100-row newest-first cap,
 * window arithmetic (default, zero, and fractional hours; truthiness-gated
 * room filtering), trust-evidence OR matching with evaluator narrowing,
 * boundary values, and the 200-row cap, behavioral-profile upsert branching
 * with JSON-stringified fields, identity link bidirectional lookup, evidence
 * persistence, and update ordering, and anonymous whistleblower report
 * persistence. Runs against an in-process PGlite with the trust schema
 * materialized from DDL mirroring ../schema.ts.
 */

import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UUID } from "../../../types/index.ts";
import {
	behavioralProfiles,
	identityLinks,
	securityIncidents,
	trustEvidence,
	whistleblowerReports,
} from "../schema.ts";
import type { DrizzleDB } from "./db.ts";
import {
	getBehavioralProfile,
	getIdentityLinks,
	getRecentIncidents,
	getTrustEvidence,
	insertIdentityLink,
	insertSecurityIncident,
	insertTrustEvidence,
	insertWhistleblowerReport,
	upsertBehavioralProfile,
} from "./SecurityStore.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let entitySeq = 0;
function nextUuid(): UUID {
	entitySeq += 1;
	return `00000000-0000-4000-8000-${String(entitySeq).padStart(12, "0")}`;
}

const ENTITY_A = nextUuid();
const ENTITY_B = nextUuid();
const ENTITY_C = nextUuid();
const ENTITY_D = nextUuid();
const EVALUATOR_1 = nextUuid();
const EVALUATOR_2 = nextUuid();

let rawDb: ReturnType<typeof drizzle>;
let db: DrizzleDB;
let client: PGlite;

const DDL = [
	`CREATE SCHEMA IF NOT EXISTS trust`,
	`CREATE TABLE IF NOT EXISTS trust.security_incidents (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		entity_id uuid NOT NULL,
		type text NOT NULL,
		severity text NOT NULL,
		context jsonb,
		details jsonb,
		timestamp timestamp DEFAULT now() NOT NULL,
		handled text DEFAULT 'pending'
	)`,
	`CREATE TABLE IF NOT EXISTS trust.trust_evidence (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		target_entity_id uuid NOT NULL,
		source_entity_id uuid NOT NULL,
		evaluator_id uuid NOT NULL,
		type text NOT NULL,
		timestamp timestamp DEFAULT now() NOT NULL,
		impact integer NOT NULL,
		weight integer DEFAULT 1,
		description text,
		verified boolean DEFAULT false,
		context jsonb
	)`,
	`CREATE TABLE IF NOT EXISTS trust.behavioral_profiles (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		entity_id uuid NOT NULL UNIQUE,
		typing_speed integer DEFAULT 0,
		vocabulary_complexity integer DEFAULT 0,
		message_length_mean integer DEFAULT 0,
		message_length_std_dev integer DEFAULT 0,
		active_hours jsonb DEFAULT '[]',
		common_phrases jsonb DEFAULT '[]',
		interaction_patterns jsonb DEFAULT '{}',
		updated_at timestamp DEFAULT now() NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS trust.identity_links (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		entity_id_a uuid NOT NULL,
		entity_id_b uuid NOT NULL,
		confidence integer NOT NULL,
		evidence jsonb DEFAULT '[]',
		updated_at timestamp DEFAULT now() NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS trust.whistleblower_reports (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		reported_entity_id uuid NOT NULL,
		evidence jsonb NOT NULL,
		status text DEFAULT 'pending',
		created_at timestamp DEFAULT now() NOT NULL
	)`,
];

async function seedIncident(values: {
	entityId?: string;
	type?: string;
	severity?: string;
	timestamp: Date;
	context?: Record<string, unknown>;
}): Promise<void> {
	await rawDb.insert(securityIncidents).values({
		entityId: values.entityId ?? ENTITY_A,
		type: values.type ?? "probe",
		severity: values.severity ?? "low",
		timestamp: values.timestamp,
		context: values.context ?? {},
	});
}

async function seedEvidence(values: {
	targetEntityId: string;
	sourceEntityId: string;
	evaluatorId: string;
	timestamp: Date;
	type?: string;
	impact?: number;
	verified?: boolean;
}): Promise<void> {
	await rawDb.insert(trustEvidence).values({
		targetEntityId: values.targetEntityId,
		sourceEntityId: values.sourceEntityId,
		evaluatorId: values.evaluatorId,
		type: values.type ?? "interaction",
		timestamp: values.timestamp,
		impact: values.impact ?? 1,
		verified: values.verified ?? false,
	});
}

function seqOf(row: Record<string, unknown>): number {
	return (row.context as { seq?: number }).seq ?? -1;
}

beforeAll(async () => {
	client = new PGlite();
	rawDb = drizzle(client);
	db = rawDb as unknown as DrizzleDB;
	for (const statement of DDL) {
		await rawDb.execute(sql.raw(statement));
	}
});

afterAll(async () => {
	await client?.close?.();
});

describe("SecurityStore on an empty database", () => {
	it("returns empty results and null profiles before anything is written", async () => {
		expect(await getRecentIncidents(db)).toEqual([]);
		expect(await getTrustEvidence(db, ENTITY_D)).toEqual([]);
		expect(await getIdentityLinks(db, ENTITY_D)).toEqual([]);
		expect(await getBehavioralProfile(db, ENTITY_D)).toBeNull();
	});
});

describe("security incidents", () => {
	it("caps recent incidents at the 100 newest rows inside the window, newest first", async () => {
		const now = Date.now();
		const recent = Array.from({ length: 102 }, (_, i) => ({
			entityId: ENTITY_A,
			type: "recent",
			severity: "low",
			timestamp: new Date(now - (i + 1) * MINUTE),
			context: { seq: i + 1 },
		}));
		const stale = Array.from({ length: 3 }, (_, i) => ({
			entityId: ENTITY_A,
			type: "stale",
			severity: "low",
			timestamp: new Date(now - 48 * HOUR - i * MINUTE),
			context: { seq: 103 + i },
		}));
		await rawDb.insert(securityIncidents).values([...recent, ...stale]);

		const rows = await getRecentIncidents(db);

		expect(rows).toHaveLength(100);
		expect(seqOf(rows[0])).toBe(1);
		expect(seqOf(rows[99])).toBe(100);
		for (const row of rows) {
			expect(row.type).toBe("recent");
		}
		const times = rows.map((row) => (row.timestamp as Date).getTime());
		for (let i = 1; i < times.length; i += 1) {
			expect(times[i - 1]).toBeGreaterThan(times[i]);
		}
	});

	it("inserts an incident stamping handled=pending and empty defaults for optional fields", async () => {
		const entityId = nextUuid();
		await insertSecurityIncident(db, {
			entityId,
			type: "prompt_injection",
			severity: "high",
		});

		const rows = await rawDb
			.select()
			.from(securityIncidents)
			.where(eq(securityIncidents.entityId, entityId));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.handled).toBe("pending");
		expect(row.context).toEqual({});
		expect(row.details).toEqual({});
		expect(row.timestamp).toBeInstanceOf(Date);
	});

	it("persists provided context and details verbatim", async () => {
		const entityId = nextUuid();
		await insertSecurityIncident(db, {
			entityId,
			type: "phishing_attempt",
			severity: "critical",
			context: { source: "unit" },
			details: { ip: "10.0.0.1" },
		});

		const rows = await rawDb
			.select()
			.from(securityIncidents)
			.where(eq(securityIncidents.entityId, entityId));
		expect(rows).toHaveLength(1);
		expect(rows[0].context).toEqual({ source: "unit" });
		expect(rows[0].details).toEqual({ ip: "10.0.0.1" });
	});

	it("filters recent incidents by the roomId stored in context", async () => {
		const now = Date.now();
		const room1 = nextUuid();
		const room2 = nextUuid();
		await seedIncident({
			timestamp: new Date(now - 5 * MINUTE),
			context: { roomId: room1 },
		});
		await seedIncident({
			timestamp: new Date(now - 6 * MINUTE),
			context: { roomId: room2 },
		});
		await seedIncident({ timestamp: new Date(now - 7 * MINUTE), context: {} });
		await seedIncident({
			timestamp: new Date(now - 48 * HOUR),
			context: { roomId: room1 },
		});

		const inRoom1 = await getRecentIncidents(db, room1);
		expect(inRoom1).toHaveLength(1);
		expect((inRoom1[0].context as { roomId: string }).roomId).toBe(room1);

		const inRoom2 = await getRecentIncidents(db, room2);
		expect(inRoom2).toHaveLength(1);

		const withoutRoom = await getRecentIncidents(db);
		expect(
			withoutRoom.filter(
				(row) => (row.context as { roomId?: string }).roomId === room1,
			),
		).toHaveLength(1);
	});

	it("honors a custom hours window", async () => {
		const now = Date.now();
		const roomId = nextUuid();
		await seedIncident({
			timestamp: new Date(now - 30 * MINUTE),
			context: { roomId },
		});
		await seedIncident({
			timestamp: new Date(now - 2 * HOUR),
			context: { roomId },
		});

		const rows = await getRecentIncidents(db, roomId, 1);
		expect(rows).toHaveLength(1);
		expect((rows[0].timestamp as Date).getTime()).toBeGreaterThan(
			Date.now() - HOUR,
		);
	});

	it("returns nothing when a zero-hour window places the cutoff at now", async () => {
		const roomId = nextUuid();
		await seedIncident({
			timestamp: new Date(Date.now() - MINUTE),
			context: { roomId },
		});

		expect(await getRecentIncidents(db, roomId, 0)).toEqual([]);
	});

	it("supports fractional-hour windows", async () => {
		const now = Date.now();
		const roomId = nextUuid();
		await seedIncident({
			timestamp: new Date(now - 10 * MINUTE),
			context: { roomId, marker: "inside" },
		});
		await seedIncident({
			timestamp: new Date(now - 45 * MINUTE),
			context: { roomId, marker: "outside" },
		});

		const rows = await getRecentIncidents(db, roomId, 0.5);
		expect(rows).toHaveLength(1);
		expect((rows[0].context as { marker?: string }).marker).toBe("inside");
	});

	it("treats an empty-string roomId as absent and skips context filtering", async () => {
		const now = Date.now();
		const room = nextUuid();
		await seedIncident({
			timestamp: new Date(now - MINUTE),
			type: "skip-filter-room",
			context: { roomId: room },
		});
		await seedIncident({
			timestamp: new Date(now - 2 * MINUTE),
			type: "skip-filter-none",
			context: {},
		});

		// runtime-invalid value exercising the truthiness guard on purpose
		const blankRoomId = "" as unknown as UUID;
		const rows = await getRecentIncidents(db, blankRoomId);
		expect(rows.some((row) => row.type === "skip-filter-room")).toBe(true);
		expect(rows.some((row) => row.type === "skip-filter-none")).toBe(true);
	});
});

describe("trust evidence", () => {
	it("persists evidence verbatim", async () => {
		await insertTrustEvidence(db, {
			targetEntityId: ENTITY_A,
			sourceEntityId: ENTITY_B,
			evaluatorId: EVALUATOR_1,
			type: "cooperation",
			impact: 5,
			weight: 2,
			description: "helped resolve an incident",
			verified: true,
			context: { channel: "dm" },
		});

		const rows = await rawDb.select().from(trustEvidence);
		const row = rows.find(
			(r) => r.description === "helped resolve an incident",
		);
		expect(row).toBeDefined();
		expect(row.targetEntityId).toBe(ENTITY_A);
		expect(row.sourceEntityId).toBe(ENTITY_B);
		expect(row.evaluatorId).toBe(EVALUATOR_1);
		expect(row.type).toBe("cooperation");
		expect(row.impact).toBe(5);
		expect(row.weight).toBe(2);
		expect(row.verified).toBe(true);
		expect(row.context).toEqual({ channel: "dm" });
	});

	it("accepts boundary impact and weight values unchanged", async () => {
		await insertTrustEvidence(db, {
			targetEntityId: ENTITY_B,
			sourceEntityId: ENTITY_C,
			evaluatorId: EVALUATOR_2,
			type: "boundary",
			impact: 0,
			weight: -3,
			description: "zero impact, negative weight",
			verified: false,
			context: {},
		});

		const rows = await rawDb.select().from(trustEvidence);
		const row = rows.find((r) => r.type === "boundary");
		expect(row).toBeDefined();
		expect(row.impact).toBe(0);
		expect(row.weight).toBe(-3);
	});

	it("matches evidence where the entity is target or source, newest first", async () => {
		const now = Date.now();
		const target = nextUuid();
		await seedEvidence({
			targetEntityId: nextUuid(),
			sourceEntityId: target,
			evaluatorId: EVALUATOR_1,
			timestamp: new Date(now - 10 * MINUTE),
			type: "older-link",
		});
		await seedEvidence({
			targetEntityId: target,
			sourceEntityId: nextUuid(),
			evaluatorId: EVALUATOR_1,
			timestamp: new Date(now - 5 * MINUTE),
			type: "newer-link",
		});
		await seedEvidence({
			targetEntityId: nextUuid(),
			sourceEntityId: nextUuid(),
			evaluatorId: EVALUATOR_1,
			timestamp: new Date(now - MINUTE),
			type: "unrelated",
		});

		const rows = await getTrustEvidence(db, target);
		expect(rows.map((row) => row.type)).toEqual(["newer-link", "older-link"]);
	});

	it("narrows matched evidence by evaluator when one is given", async () => {
		const target = nextUuid();
		await seedEvidence({
			targetEntityId: target,
			sourceEntityId: nextUuid(),
			evaluatorId: EVALUATOR_1,
			timestamp: new Date(Date.now() - MINUTE),
			type: "from-evaluator-1",
		});
		await seedEvidence({
			targetEntityId: target,
			sourceEntityId: nextUuid(),
			evaluatorId: EVALUATOR_2,
			timestamp: new Date(Date.now() - MINUTE),
			type: "from-evaluator-2",
		});

		const rows = await getTrustEvidence(db, target, EVALUATOR_1);
		expect(rows.map((row) => row.type)).toEqual(["from-evaluator-1"]);

		const unknownEvaluator = await getTrustEvidence(db, target, nextUuid());
		expect(unknownEvaluator).toEqual([]);
	});

	it("caps results at the 200 most recent records", async () => {
		const now = Date.now();
		const target = nextUuid();
		const source = nextUuid();
		const batch = Array.from({ length: 205 }, (_, i) => ({
			targetEntityId: target,
			sourceEntityId: source,
			evaluatorId: EVALUATOR_1,
			type: `bulk-${i + 1}`,
			timestamp: new Date(now - (i + 1) * MINUTE),
			impact: 1,
		}));
		await rawDb.insert(trustEvidence).values(batch);

		const rows = await getTrustEvidence(db, target);
		expect(rows).toHaveLength(200);
		expect(rows[0].type).toBe("bulk-1");
		expect(rows[199].type).toBe("bulk-200");
		expect(rows.some((row) => row.type === "bulk-205")).toBe(false);
	});
});

describe("behavioral profiles", () => {
	it("inserts a profile applying zero defaults and storing collections as JSON", async () => {
		const entityId = nextUuid();
		await upsertBehavioralProfile(db, {
			entityId,
			typingSpeed: 42,
			activeHours: [9, 10],
			commonPhrases: ["hello"],
		});

		const profile = await getBehavioralProfile(db, entityId);
		expect(profile).not.toBeNull();
		expect(profile.entityId).toBe(entityId);
		expect(profile.typingSpeed).toBe(42);
		expect(profile.vocabularyComplexity).toBe(0);
		expect(profile.messageLengthMean).toBe(0);
		expect(profile.messageLengthStdDev).toBe(0);
		expect(profile.activeHours).toEqual([9, 10]);
		expect(profile.commonPhrases).toEqual(["hello"]);
		expect(profile.interactionPatterns).toEqual({});
	});

	it("updates in place on a second upsert, restamping omitted fields with defaults", async () => {
		const entityId = nextUuid();
		await upsertBehavioralProfile(db, {
			entityId,
			typingSpeed: 10,
			activeHours: [3],
			interactionPatterns: { reply: 4 },
		});
		await upsertBehavioralProfile(db, { entityId, typingSpeed: 77 });

		const rows = await rawDb
			.select()
			.from(behavioralProfiles)
			.where(eq(behavioralProfiles.entityId, entityId));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.typingSpeed).toBe(77);
		expect(row.activeHours).toEqual([]);
		expect(row.interactionPatterns).toEqual({});

		const profile = await getBehavioralProfile(db, entityId);
		expect(profile.typingSpeed).toBe(77);
		expect(profile.updatedAt).toBeInstanceOf(Date);
	});

	it("normalizes runtime-null optionals through the same defaulting path", async () => {
		const entityId = nextUuid();
		const profile = {
			entityId,
			vocabularyComplexity: null,
			commonPhrases: null,
		} as unknown as Parameters<typeof upsertBehavioralProfile>[1];
		await upsertBehavioralProfile(db, profile);

		const stored = await getBehavioralProfile(db, entityId);
		expect(stored).not.toBeNull();
		expect(stored.vocabularyComplexity).toBe(0);
		expect(stored.commonPhrases).toEqual([]);
		expect(stored.interactionPatterns).toEqual({});
	});

	it("still returns null for an entity that never got a profile", async () => {
		expect(await getBehavioralProfile(db, nextUuid())).toBeNull();
	});
});

describe("identity links", () => {
	it("inserts a link defaulting missing evidence to an empty list", async () => {
		const a = nextUuid();
		const b = nextUuid();
		await insertIdentityLink(db, {
			entityIdA: a,
			entityIdB: b,
			confidence: 80,
		});

		const rows = await rawDb.select().from(identityLinks);
		const row = rows.find((r) => r.entityIdA === a && r.entityIdB === b);
		expect(row).toBeDefined();
		expect(row.confidence).toBe(80);
		expect(row.evidence).toEqual([]);
		expect(row.updatedAt).toBeInstanceOf(Date);
	});

	it("persists provided evidence verbatim and accepts a zero confidence", async () => {
		const a = nextUuid();
		const b = nextUuid();
		await insertIdentityLink(db, {
			entityIdA: a,
			entityIdB: b,
			confidence: 0,
			evidence: ["same avatar hash", "overlapping active hours"],
		});

		const rows = await rawDb.select().from(identityLinks);
		const row = rows.find((r) => r.entityIdA === a && r.entityIdB === b);
		expect(row).toBeDefined();
		expect(row.confidence).toBe(0);
		expect(row.evidence).toEqual([
			"same avatar hash",
			"overlapping active hours",
		]);
	});

	it("matches links from either side and excludes unrelated entities", async () => {
		await insertIdentityLink(db, {
			entityIdA: ENTITY_A,
			entityIdB: ENTITY_B,
			confidence: 60,
		});
		await insertIdentityLink(db, {
			entityIdA: ENTITY_B,
			entityIdB: ENTITY_C,
			confidence: 70,
		});

		const forA = await getIdentityLinks(db, ENTITY_A);
		expect(forA).toHaveLength(1);
		expect(forA[0].confidence).toBe(60);

		const forB = await getIdentityLinks(db, ENTITY_B);
		expect(forB).toHaveLength(2);

		const forC = await getIdentityLinks(db, ENTITY_C);
		expect(forC).toHaveLength(1);
		expect(forC[0].confidence).toBe(70);

		expect(await getIdentityLinks(db, ENTITY_D)).toEqual([]);
	});

	it("orders links by most recently updated first", async () => {
		await insertIdentityLink(db, {
			entityIdA: ENTITY_D,
			entityIdB: ENTITY_A,
			confidence: 50,
		});
		await insertIdentityLink(db, {
			entityIdA: ENTITY_D,
			entityIdB: ENTITY_B,
			confidence: 55,
		});
		const inserted = await getIdentityLinks(db, ENTITY_D);
		expect(inserted).toHaveLength(2);

		const now = Date.now();
		await rawDb
			.update(identityLinks)
			.set({ updatedAt: new Date(now - 2 * HOUR) })
			.where(eq(identityLinks.entityIdB, ENTITY_A));
		await rawDb
			.update(identityLinks)
			.set({ updatedAt: new Date(now - HOUR) })
			.where(eq(identityLinks.entityIdB, ENTITY_B));

		const rows = await getIdentityLinks(db, ENTITY_D);
		expect(rows.map((row) => row.entityIdB)).toEqual([ENTITY_B, ENTITY_A]);
	});
});

describe("whistleblower reports", () => {
	it("stores an anonymous report stamped pending with no reporter column", async () => {
		const reported = nextUuid();
		await insertWhistleblowerReport(db, {
			reportedEntityId: reported,
			evidence: { channel: "dm", snippet: "suspicious link" },
		});

		const rows = await rawDb.select().from(whistleblowerReports);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.reportedEntityId).toBe(reported);
		expect(row.status).toBe("pending");
		expect(row.evidence).toEqual({ channel: "dm", snippet: "suspicious link" });
		expect(Object.keys(row).sort()).toEqual([
			"createdAt",
			"evidence",
			"id",
			"reportedEntityId",
			"status",
		]);
	});

	it("stores an empty evidence object without substituting a default", async () => {
		const reported = nextUuid();
		await insertWhistleblowerReport(db, {
			reportedEntityId: reported,
			evidence: {},
		});

		const rows = await rawDb.select().from(whistleblowerReports);
		const row = rows.find((r) => r.reportedEntityId === reported);
		expect(row?.status).toBe("pending");
		expect(row?.evidence).toEqual({});
	});
});
