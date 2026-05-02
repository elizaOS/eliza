/**
 * Data access layer for runtime trust schema tables.
 * Thin wrappers around Drizzle queries for security incidents,
 * trust evidence, behavioral profiles, identity links, and whistleblower reports.
 */

import { and, desc, eq, gt, or, type SQL } from "drizzle-orm";
import type { UUID } from "../../../types/index.ts";
import {
	behavioralProfiles,
	identityLinks,
	securityIncidents,
	trustEvidence,
	whistleblowerReports,
} from "../schema.ts";
import type { DrizzleDB } from "./db.ts";

// ─── Security Incidents ────────────────────────────────────────────────────

export interface InsertSecurityIncident {
	entityId: UUID;
	type: string;
	severity: string;
	context?: Record<string, unknown>;
	details?: Record<string, unknown>;
}

export async function insertSecurityIncident(
	db: DrizzleDB,
	incident: InsertSecurityIncident,
): Promise<void> {
	await db.insert(securityIncidents).values({
		entityId: incident.entityId,
		type: incident.type,
		severity: incident.severity,
		context: incident.context ?? {},
		details: incident.details ?? {},
		handled: "pending",
	});
}

export async function getRecentIncidents(
	db: DrizzleDB,
	roomId?: UUID,
	hours = 24,
): Promise<Array<Record<string, unknown>>> {
	const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
	const rows: Array<Record<string, unknown>> = await db
		.select()
		.from(securityIncidents)
		.where(gt(securityIncidents.timestamp, cutoff))
		.orderBy(desc(securityIncidents.timestamp))
		.limit(100);

	// Filter by roomId if provided (stored in context JSONB)
	if (roomId) {
		return rows.filter((row) => {
			const ctx = row.context as Record<string, unknown> | null;
			return ctx?.roomId === roomId;
		});
	}
	return rows;
}

// ─── Trust Evidence ────────────────────────────────────────────────────────

export interface InsertTrustEvidence {
	targetEntityId: UUID;
	sourceEntityId: UUID;
	evaluatorId: UUID;
	type: string;
	impact: number;
	weight?: number;
	description?: string;
	verified?: boolean;
	context?: Record<string, unknown>;
}

export async function insertTrustEvidence(
	db: DrizzleDB,
	evidence: InsertTrustEvidence,
): Promise<void> {
	await db.insert(trustEvidence).values({
		targetEntityId: evidence.targetEntityId,
		sourceEntityId: evidence.sourceEntityId,
		evaluatorId: evidence.evaluatorId,
		type: evidence.type,
		impact: evidence.impact,
		weight: evidence.weight ?? 1,
		description: evidence.description ?? "",
		verified: evidence.verified ?? false,
		context: evidence.context ?? {},
	});
}

export async function getTrustEvidence(
	db: DrizzleDB,
	entityId: UUID,
	evaluatorId?: UUID,
): Promise<Array<Record<string, unknown>>> {
	const evidenceCondition = or(
		eq(trustEvidence.targetEntityId, entityId),
		eq(trustEvidence.sourceEntityId, entityId),
	);
	if (!evidenceCondition) {
		return [];
	}
	const conditions: SQL[] = [evidenceCondition];
	if (evaluatorId) {
		conditions.push(eq(trustEvidence.evaluatorId, evaluatorId));
	}
	return db
		.select()
		.from(trustEvidence)
		.where(and(...conditions))
		.orderBy(desc(trustEvidence.timestamp))
		.limit(200);
}

// ─── Behavioral Profiles ───────────────────────────────────────────────────

export interface UpsertBehavioralProfile {
	entityId: UUID;
	typingSpeed?: number;
	vocabularyComplexity?: number;
	messageLengthMean?: number;
	messageLengthStdDev?: number;
	activeHours?: number[];
	commonPhrases?: string[];
	interactionPatterns?: Record<string, number>;
}

export async function upsertBehavioralProfile(
	db: DrizzleDB,
	profile: UpsertBehavioralProfile,
): Promise<void> {
	const fields = {
		typingSpeed: profile.typingSpeed ?? 0,
		vocabularyComplexity: profile.vocabularyComplexity ?? 0,
		messageLengthMean: profile.messageLengthMean ?? 0,
		messageLengthStdDev: profile.messageLengthStdDev ?? 0,
		activeHours: JSON.stringify(profile.activeHours ?? []),
		commonPhrases: JSON.stringify(profile.commonPhrases ?? []),
		interactionPatterns: JSON.stringify(profile.interactionPatterns ?? {}),
	};

	const existing = await db
		.select()
		.from(behavioralProfiles)
		.where(eq(behavioralProfiles.entityId, profile.entityId))
		.limit(1);

	if ((existing as unknown[]).length > 0) {
		await db
			.update(behavioralProfiles)
			.set({ ...fields, updatedAt: new Date() })
			.where(eq(behavioralProfiles.entityId, profile.entityId));
	} else {
		await db
			.insert(behavioralProfiles)
			.values({ entityId: profile.entityId, ...fields });
	}
}

export async function getBehavioralProfile(
	db: DrizzleDB,
	entityId: UUID,
): Promise<Record<string, unknown> | null> {
	const rows = await db
		.select()
		.from(behavioralProfiles)
		.where(eq(behavioralProfiles.entityId, entityId))
		.limit(1);
	const result = rows as unknown[];
	return result.length > 0 ? (result[0] as Record<string, unknown>) : null;
}

// ─── Identity Links ────────────────────────────────────────────────────────

export async function insertIdentityLink(
	db: DrizzleDB,
	link: {
		entityIdA: UUID;
		entityIdB: UUID;
		confidence: number;
		evidence?: string[];
	},
): Promise<void> {
	await db.insert(identityLinks).values({
		entityIdA: link.entityIdA,
		entityIdB: link.entityIdB,
		confidence: link.confidence,
		evidence: JSON.stringify(link.evidence ?? []),
	});
}

export async function getIdentityLinks(
	db: DrizzleDB,
	entityId: UUID,
): Promise<Array<Record<string, unknown>>> {
	return db
		.select()
		.from(identityLinks)
		.where(
			or(
				eq(identityLinks.entityIdA, entityId),
				eq(identityLinks.entityIdB, entityId),
			),
		)
		.orderBy(desc(identityLinks.updatedAt));
}

// ─── Whistleblower Reports ─────────────────────────────────────────────────

export async function insertWhistleblowerReport(
	db: DrizzleDB,
	report: { reportedEntityId: UUID; evidence: Record<string, unknown> },
): Promise<void> {
	await db.insert(whistleblowerReports).values({
		reportedEntityId: report.reportedEntityId,
		evidence: report.evidence,
		status: "pending",
	});
}
