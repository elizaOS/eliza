/**
 * FactRefinementEvaluator
 *
 * Honcho-style dialectic refinement for the facts memory store. Runs on the
 * same trigger as the summarization evaluator: when a fresh summary lands we
 * compare every existing fact for the relevant entity against the summary
 * and classify the implication:
 *
 *   - add         → new fact memory
 *   - strengthen  → bump confidence and update lastReinforced
 *   - decay       → drop confidence; delete when below FACT_DECAY_FLOOR
 *   - merge       → write to fact_candidates for human review
 *   - contradict  → write to fact_candidates for human review
 *
 * The schema-level `fact_candidates` table receives anything we cannot apply
 * automatically. The Facts UI surfaces those as "I noticed conflicting info".
 */

import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	Evaluator,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";
import { MemoryType } from "../../../types/memory.ts";
import { asUUID } from "../../../types/primitives.ts";

type RefinementAction = "add" | "strengthen" | "decay" | "merge" | "contradict";

interface RefinementProposal {
	action: RefinementAction;
	factId?: string;
	text?: string;
	reason?: string;
}

const STRENGTHEN_DELTA = 0.1;
const DECAY_DELTA = 0.15;
const FACT_DECAY_FLOOR = 0.2;
const MAX_FACTS_REVIEWED = 50;
const SUMMARY_MEMORY_TYPE = "session_summary";

/**
 * Mirrors the summarization evaluator's trigger condition. We call into the
 * memory service if available to avoid duplicating the threshold math; if
 * the service is unavailable we skip rather than guess.
 */
async function summarizationTriggered(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	if (!message.content?.text) return false;
	const memoryServiceUnknown = runtime.getService("memory") as unknown;
	if (!memoryServiceUnknown || typeof memoryServiceUnknown !== "object") {
		return false;
	}
	const memoryService = memoryServiceUnknown as {
		getConfig?: () => {
			shortTermSummarizationThreshold?: number;
			shortTermSummarizationInterval?: number;
		};
		getCurrentSessionSummary?: (roomId: UUID) => Promise<{
			lastMessageOffset?: number;
		} | null>;
	};
	if (
		typeof memoryService.getConfig !== "function" ||
		typeof memoryService.getCurrentSessionSummary !== "function"
	) {
		return false;
	}
	const config = memoryService.getConfig();
	const summary = await memoryService.getCurrentSessionSummary(message.roomId);
	const recentMessages = await runtime.getMemories({
		tableName: "messages",
		roomId: message.roomId,
		limit: 200,
		unique: false,
	});
	const dialogueCount = recentMessages.length;
	if (!summary) {
		const threshold = config.shortTermSummarizationThreshold ?? 10;
		return dialogueCount >= threshold;
	}
	const interval = config.shortTermSummarizationInterval ?? 5;
	const newCount = dialogueCount - (summary.lastMessageOffset ?? 0);
	return newCount >= interval;
}

interface FactMetadataLike {
	confidence?: number;
	lastReinforced?: string;
	evidenceMessageIds?: UUID[];
	sourceTrajectoryId?: UUID;
	[extra: string]: unknown;
}

function readFactMetadata(memory: Memory): FactMetadataLike {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadataLike;
}

function pickFactConfidence(memory: Memory): number {
	const meta = readFactMetadata(memory);
	const value = meta.confidence;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return 0.6;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function asUuidOrNull(value: unknown): UUID | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return asUUID(value);
}

function buildRefinementPrompt(summaryText: string, facts: Memory[]): string {
	const factLines = facts
		.map((fact, index) => {
			const id = fact.id ?? `idx_${index}`;
			const confidence = pickFactConfidence(fact);
			const text = fact.content?.text ?? "";
			return `[${id}] (conf=${confidence.toFixed(2)}) ${text}`;
		})
		.join("\n");

	return `You are refining a knowledge base for an AI assistant.

A new conversation summary has just been generated. For each existing fact
about a specific person, decide what to do given the summary.

Allowed actions:
- "add"        – the summary establishes a new durable fact not yet in the
                 list. Provide the new fact text. (No factId required.)
- "strengthen" – the summary reinforces an existing fact. Provide its factId.
- "decay"      – the summary makes the fact look less likely (no longer
                 mentioned, contradicted obliquely). Provide its factId.
- "contradict" – the summary explicitly contradicts an existing fact. Provide
                 its factId and a one-line reason.
- "merge"      – two facts overlap and could be consolidated. Provide its
                 factId and the proposed merged text.

Return ONLY a JSON array of objects: { "action", "factId?", "text?", "reason?" }.
Empty array means no changes.

Conversation summary:
${summaryText}

Existing facts:
${factLines || "(no facts on file yet)"}
`;
}

function parseRefinementResponse(raw: string): RefinementProposal[] {
	const match = raw.match(/\[[\s\S]*\]/);
	if (!match) return [];
	const parsed = JSON.parse(match[0]) as unknown;
	if (!Array.isArray(parsed)) return [];
	const proposals: RefinementProposal[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const action = record.action;
		if (
			action !== "add" &&
			action !== "strengthen" &&
			action !== "decay" &&
			action !== "merge" &&
			action !== "contradict"
		) {
			continue;
		}
		proposals.push({
			action,
			factId: typeof record.factId === "string" ? record.factId : undefined,
			text: typeof record.text === "string" ? record.text : undefined,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		});
	}
	return proposals;
}

async function applyStrengthen(
	runtime: IAgentRuntime,
	fact: Memory,
	evidenceMessageId: UUID | null,
): Promise<void> {
	const meta = readFactMetadata(fact);
	const nextConfidence = clamp01(pickFactConfidence(fact) + STRENGTHEN_DELTA);
	const evidence = Array.isArray(meta.evidenceMessageIds)
		? [...meta.evidenceMessageIds]
		: [];
	if (evidenceMessageId && !evidence.includes(evidenceMessageId)) {
		evidence.push(evidenceMessageId);
	}
	if (
		typeof runtime.updateMemory !== "function" ||
		typeof fact.id !== "string"
	) {
		return;
	}
	await runtime.updateMemory({
		id: fact.id as UUID,
		metadata: {
			...meta,
			type: MemoryType.CUSTOM,
			confidence: nextConfidence,
			lastReinforced: new Date().toISOString(),
			evidenceMessageIds: evidence,
		},
	});
}

async function applyDecay(runtime: IAgentRuntime, fact: Memory): Promise<void> {
	const meta = readFactMetadata(fact);
	const nextConfidence = clamp01(pickFactConfidence(fact) - DECAY_DELTA);
	if (nextConfidence < FACT_DECAY_FLOOR) {
		if (
			typeof runtime.deleteMemory === "function" &&
			typeof fact.id === "string"
		) {
			await runtime.deleteMemory(fact.id as UUID);
		}
		return;
	}
	if (
		typeof runtime.updateMemory !== "function" ||
		typeof fact.id !== "string"
	) {
		return;
	}
	await runtime.updateMemory({
		id: fact.id as UUID,
		metadata: {
			...meta,
			type: MemoryType.CUSTOM,
			confidence: nextConfidence,
		},
	});
}

async function applyAdd(
	runtime: IAgentRuntime,
	message: Memory,
	text: string,
): Promise<void> {
	const factId = asUUID(v4());
	const evidenceIds: UUID[] = message.id ? [message.id] : [];
	await runtime.createMemory(
		{
			id: factId,
			entityId: message.entityId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			content: { text },
			metadata: {
				type: MemoryType.CUSTOM,
				source: "fact_refinement",
				confidence: 0.7,
				lastReinforced: new Date().toISOString(),
				evidenceMessageIds: evidenceIds,
			},
			createdAt: Date.now(),
		},
		"facts",
		true,
	);
}

interface RuntimeDbExecutor {
	execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
}

async function getRuntimeDb(
	runtime: IAgentRuntime,
): Promise<RuntimeDbExecutor | null> {
	const adapter = (runtime as IAgentRuntime & { adapter?: { db?: unknown } })
		.adapter;
	const db = adapter?.db as RuntimeDbExecutor | undefined;
	if (!db || typeof db.execute !== "function") return null;
	return db;
}

function sqlQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlJsonbLiteral(value: unknown): string {
	return `${sqlQuote(JSON.stringify(value ?? null))}::jsonb`;
}

async function recordFactCandidate(
	runtime: IAgentRuntime,
	params: {
		entityId: UUID;
		kind: "contradict" | "merge";
		existingFactId?: UUID;
		proposedText: string;
		reason?: string;
		evidenceMessageId?: UUID;
	},
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

export const factRefinementEvaluator: Evaluator = {
	name: "FACT_REFINEMENT",
	description:
		"Honcho-style dialectic refinement: classify each existing fact against the latest summary and apply add/strengthen/decay automatically; queue contradict/merge for review.",
	similes: ["FACT_DIALECTIC", "FACT_REFRESHER", "FACT_PRUNER"],
	alwaysRun: false,
	examples: [],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		return summarizationTriggered(runtime, message);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ActionResult | undefined> => {
		const entityId = message.entityId;
		if (!entityId) return undefined;

		const [existingFacts, summaryMemories] = await Promise.all([
			runtime.getMemories({
				tableName: "facts",
				roomId: message.roomId,
				entityId,
				count: MAX_FACTS_REVIEWED,
				unique: true,
			}),
			runtime.getMemories({
				tableName: "memories",
				roomId: message.roomId,
				count: 5,
				unique: false,
			}),
		]);

		const latestSummary = summaryMemories
			.filter((memory) => {
				const meta = memory.metadata;
				if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
					return false;
				}
				const record = meta as Record<string, unknown>;
				return (
					record.type === SUMMARY_MEMORY_TYPE ||
					record.source === "session_summary"
				);
			})
			.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0];

		const summaryText =
			latestSummary?.content?.text?.trim() ??
			message.content?.text?.trim() ??
			"";

		if (!summaryText) {
			return undefined;
		}

		const prompt = buildRefinementPrompt(summaryText, existingFacts);
		const response = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 600,
			temperature: 0,
		});
		const proposals = parseRefinementResponse(response);
		if (proposals.length === 0) {
			logger.debug(
				"[FactRefinementEvaluator] No refinements produced for room " +
					message.roomId,
			);
			return undefined;
		}

		const factById = new Map<string, Memory>();
		for (const fact of existingFacts) {
			if (fact.id) factById.set(fact.id, fact);
		}

		let applied = 0;
		let queued = 0;

		for (const proposal of proposals) {
			if (proposal.action === "add" && proposal.text) {
				await applyAdd(runtime, message, proposal.text);
				applied += 1;
				continue;
			}

			if (!proposal.factId) continue;
			const fact = factById.get(proposal.factId);
			if (!fact) continue;

			if (proposal.action === "strengthen") {
				await applyStrengthen(runtime, fact, asUuidOrNull(message.id));
				applied += 1;
				continue;
			}
			if (proposal.action === "decay") {
				await applyDecay(runtime, fact);
				applied += 1;
				continue;
			}
			if (proposal.action === "contradict" || proposal.action === "merge") {
				await recordFactCandidate(runtime, {
					entityId,
					kind: proposal.action,
					existingFactId: asUuidOrNull(fact.id) ?? undefined,
					proposedText: proposal.text ?? fact.content?.text ?? "",
					reason: proposal.reason,
					evidenceMessageId: asUuidOrNull(message.id) ?? undefined,
				});
				queued += 1;
			}
		}

		logger.info(
			`[FactRefinementEvaluator] Applied ${applied}, queued ${queued} for room ${message.roomId}`,
		);

		return {
			success: true,
			values: { applied, queued },
			data: { applied, queued },
			text: `Refined ${applied} facts; queued ${queued} for review.`,
		};
	},
};
