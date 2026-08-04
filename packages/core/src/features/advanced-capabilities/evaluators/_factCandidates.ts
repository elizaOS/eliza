/**
 * Persists pending fact reconciliations for the Facts review UI.
 * Schema provisioning belongs to the database layer; this helper only appends contradictions.
 */
import { sql } from "drizzle-orm";
import type { IAgentRuntime, UUID } from "../../../types/index.ts";

interface RuntimeDbExecutor {
	execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
}

async function getRuntimeDb(
	runtime: IAgentRuntime,
): Promise<RuntimeDbExecutor | null> {
	const adapter = (runtime as IAgentRuntime & { adapter?: { db?: unknown } })
		.adapter;
	const db = adapter.db as RuntimeDbExecutor | undefined;
	if (!db || typeof db.execute !== "function") return null;
	return db;
}

function sqlQuote(value: string): string {
	return `'${value.split("'").join("''")}'`;
}

function sqlJsonbLiteral(value: unknown): string {
	return `${sqlQuote(JSON.stringify(value ?? null))}::jsonb`;
}

export interface FactCandidateRecord {
	entityId: UUID;
	kind: "contradict" | "merge";
	existingFactId?: UUID;
	proposedText: string;
	reason?: string;
	evidenceMessageId?: UUID;
}

export async function recordFactCandidate(
	runtime: IAgentRuntime,
	params: FactCandidateRecord,
): Promise<void> {
	const db = await getRuntimeDb(runtime);
	if (!db) return;
	const evidence = {
		reason: params.reason,
		evidenceMessageId: params.evidenceMessageId,
	};
	const sqlText = `INSERT INTO fact_candidates (
			agent_id, entity_id, kind, existing_fact_id, proposed_text,
			confidence, evidence, status
		) VALUES (
			${sqlQuote(runtime.agentId)},
			${sqlQuote(params.entityId)},
			${sqlQuote(params.kind)},
			${params.existingFactId ? sqlQuote(params.existingFactId) : "NULL"},
			${sqlQuote(params.proposedText)},
			0.6,
			${sqlJsonbLiteral(evidence)},
			'pending'
		)`;
	await db.execute(sql.raw(sqlText));
}
