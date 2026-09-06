/**
 * Persists pending fact-reconciliation proposals without modifying existing facts.
 * Schema provisioning belongs to the database layer; storage failures propagate
 * to the evaluator boundary.
 */
import { sql } from "drizzle-orm";
import { ElizaError } from "../../../errors.ts";
import type { IAgentRuntime, UUID } from "../../../types/index.ts";

interface RuntimeDbExecutor {
	execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
}

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDbExecutor {
	const adapter = (runtime as IAgentRuntime & { adapter?: { db?: unknown } })
		.adapter;
	const db = adapter?.db as RuntimeDbExecutor | undefined;
	if (!db || typeof db.execute !== "function") {
		throw new ElizaError("Fact candidate storage requires a SQL executor", {
			code: "FACT_CANDIDATE_STORAGE_UNAVAILABLE",
			context: { agentId: runtime.agentId },
		});
	}
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
	const db = getRuntimeDb(runtime);
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
