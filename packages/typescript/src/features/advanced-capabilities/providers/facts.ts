import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("FACTS");

/**
 * Half-life in milliseconds used to decay a fact's recency weight when ranking
 * facts for the prompt. 30 days is short enough to deprioritize stale facts
 * but long enough to keep durable preferences front-and-center.
 */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_FACT_CONFIDENCE = 0.6;

function readMetadataRecord(memory: Memory): Record<string, unknown> {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as Record<string, unknown>;
}

function readFactConfidence(memory: Memory): number {
	const value = readMetadataRecord(memory).confidence;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_FACT_CONFIDENCE;
	}
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function readLastReinforcedMs(memory: Memory): number | null {
	const meta = readMetadataRecord(memory);
	const explicit = meta.lastReinforced;
	if (typeof explicit === "string") {
		const parsed = Date.parse(explicit);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (
		typeof memory.createdAt === "number" &&
		Number.isFinite(memory.createdAt)
	) {
		return memory.createdAt;
	}
	return null;
}

function recencyWeight(lastReinforcedMs: number | null, nowMs: number): number {
	if (lastReinforcedMs === null) return 0.5;
	const ageMs = Math.max(0, nowMs - lastReinforcedMs);
	return 0.5 ** (ageMs / RECENCY_HALF_LIFE_MS);
}

function rankFacts(facts: Memory[]): Memory[] {
	const nowMs = Date.now();
	const ranked = [...facts].sort((left, right) => {
		const leftScore =
			readFactConfidence(left) *
			recencyWeight(readLastReinforcedMs(left), nowMs);
		const rightScore =
			readFactConfidence(right) *
			recencyWeight(readLastReinforcedMs(right), nowMs);
		return rightScore - leftScore;
	});
	return ranked;
}

/**
 * Formats facts as `[conf=0.93] <text>` lines so the LLM can weigh
 * conflicting information against the recorded confidence.
 */
function formatFacts(facts: Memory[]): string {
	const lines: string[] = [];
	for (const fact of facts) {
		const text = fact.content.text ?? "";
		if (!text) continue;
		const confidence = readFactConfidence(fact).toFixed(2);
		lines.push(`[conf=${confidence}] ${text}`);
	}
	return lines.join("\n");
}

/**
 * Function to get key facts that the agent knows.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {Memory} message - The message object containing relevant information.
 * @param {State} [_state] - Optional state information.
 * @returns {Object} An object containing values, data, and text related to the key facts.
 */
const factsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
		// Parallelize initial data fetching operations including recentInteractions
		const recentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: 10,
			unique: false,
		});

		// join the text of the last 5 messages
		const lastMessageLines: string[] = [];
		for (
			let i = recentMessages.length - 1;
			i >= 0 && lastMessageLines.length < 5;
			i -= 1
		) {
			lastMessageLines.push(recentMessages[i]?.content.text ?? "");
		}
		lastMessageLines.reverse();
		const last5Messages = lastMessageLines.join("\n");

		const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: last5Messages,
		});

		const [relevantFacts, recentFactsData] = await Promise.all([
			runtime.searchMemories({
				tableName: "facts",
				embedding,
				roomId: message.roomId,
				worldId: message.worldId,
				limit: 6,
				query: message.content.text,
			}),
			runtime.searchMemories({
				embedding,
				query: message.content.text,
				tableName: "facts",
				roomId: message.roomId,
				entityId: message.entityId,
				limit: 6,
			}),
		]);

		// join the two and deduplicate
		const seenIds = new Set<string>();
		const dedupedFacts: Memory[] = [];
		for (const fact of [...relevantFacts, ...recentFactsData]) {
			const factId = fact.id ?? "";
			if (factId && !seenIds.has(factId)) {
				seenIds.add(factId);
				dedupedFacts.push(fact);
			}
		}
		// Re-order by confidence * recency-decay so the LLM sees the most
		// trustworthy, recently-reinforced facts first.
		const allFacts = rankFacts(dedupedFacts);

		if (allFacts.length === 0) {
			return {
				values: {
					facts: "",
				},
				data: {
					facts: allFacts,
				},
				text: "No facts available.",
			};
		}

		const formattedFacts = formatFacts(allFacts);

		const agentName = runtime.character.name ?? "Agent";
		const text = "Key facts that {{agentName}} knows:\n{{formattedFacts}}"
			.replace("{{agentName}}", agentName)
			.replace("{{formattedFacts}}", formattedFacts);

		return {
			values: {
				facts: formattedFacts,
			},
			data: {
				facts: allFacts,
			},
			text,
		};
	},
};

export { factsProvider };
