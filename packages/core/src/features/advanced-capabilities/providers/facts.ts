import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { getRelatedEntityIds } from "../../../identity-clusters.ts";
import type {
	FactKind,
	FactMetadata,
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import { ModelType } from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("FACTS");

/**
 * Decay constant for `current` facts in the read-path ranking.
 *
 * Score = `confidence × exp(-ageDays / 14)` so a fact is at full weight on
 * day zero, ~50% at 14 days, and ~14% at 30 days. There is no hard cutoff —
 * very old current facts can still surface when relevance is high enough
 * (see `docs/architecture/fact-memory.md`). Durable facts skip decay
 * entirely (`timeWeight = 1`).
 */
const CURRENT_DECAY_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_FACT_CONFIDENCE = 0.6;

/**
 * How many candidates we pull per kind from `searchMemories`. The runtime
 * search API does not accept metadata filters, so we fetch a wider pool and
 * partition by `metadata.kind` in TypeScript before ranking. The final
 * cap per section is `TOP_PER_KIND`.
 */
const CANDIDATE_POOL_PER_SEARCH = 20;
const TOP_PER_KIND = 6;

/**
 * Internal timeout for the embedding seed that drives FACTS retrieval. The
 * provider runtime gives every provider 30s for its full state-composition
 * pass; if `useModel(TEXT_EMBEDDING, ...)` hangs (e.g. the local llama.cpp
 * embedding backend failed to build or the remote embedding endpoint is
 * unreachable) we burn the full 30s on every turn waiting for the outer
 * cut. Race the embedding call against a much shorter internal limit and
 * fall through to the `catch` block (which returns empty facts) so the
 * provider degrades to "no facts" instead of "30s of dead air per turn".
 *
 * 3s is comfortably above a healthy embedding round-trip (warm local
 * bge-small-en-v1.5 returns in ~50-150ms; warm cloud endpoint in
 * ~100-400ms) and well below the 30s outer cut.
 */
const EMBEDDING_TIMEOUT_MS = 3000;

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function readFactConfidence(memory: Memory): number {
	const value = readFactMetadata(memory).confidence;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_FACT_CONFIDENCE;
	}
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Resolve a fact's kind. Legacy facts written before the two-store model
 * carry no `kind` metadata; treat them as durable per the lazy
 * reclassification policy in `fact-memory.md`.
 */
function readFactKind(memory: Memory): FactKind {
	const kind = readFactMetadata(memory).kind;
	if (kind === "current") return "current";
	return "durable";
}

/**
 * Resolve the timestamp used for time-weighting and the `since` label on
 * current facts. Prefers `metadata.validAt` (when state began) and falls
 * back to `createdAt` so legacy facts and current facts that omit
 * `valid_at` still rank consistently.
 */
function readEffectiveTimestampMs(memory: Memory): number | null {
	const validAt = readFactMetadata(memory).validAt;
	if (typeof validAt === "string") {
		const parsed = Date.parse(validAt);
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

/**
 * Per-kind time weight applied during ranking.
 *   - durable → 1 always (identity-level claims do not decay)
 *   - current → exp(-ageDays / 14) (curved decay, never zero)
 */
function timeWeight(kind: FactKind, ageMs: number): number {
	if (kind === "durable") return 1;
	const safeAgeMs = ageMs < 0 ? 0 : ageMs;
	const ageDays = safeAgeMs / MS_PER_DAY;
	return Math.exp(-ageDays / CURRENT_DECAY_DAYS);
}

function scoreFact(memory: Memory, kind: FactKind, nowMs: number): number {
	const ts = readEffectiveTimestampMs(memory);
	const ageMs = ts === null ? 0 : Math.max(0, nowMs - ts);
	return readFactConfidence(memory) * timeWeight(kind, ageMs);
}

function rankByScore(
	memories: Memory[],
	kind: FactKind,
	nowMs: number,
): Memory[] {
	return [...memories].sort(
		(left, right) =>
			scoreFact(right, kind, nowMs) - scoreFact(left, kind, nowMs),
	);
}

function dedupeById(memories: Memory[]): Memory[] {
	const seen = new Set<string>();
	const out: Memory[] = [];
	for (const memory of memories) {
		const id = memory.id ?? "";
		if (!id) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(memory);
	}
	return out;
}

/**
 * Partition a candidate pool into durable vs current. Legacy facts (no
 * `kind` field) are treated as durable.
 */
function partitionByKind(memories: Memory[]): {
	durable: Memory[];
	current: Memory[];
} {
	const durable: Memory[] = [];
	const current: Memory[] = [];
	for (const memory of memories) {
		if (readFactKind(memory) === "current") current.push(memory);
		else durable.push(memory);
	}
	return { durable, current };
}

/**
 * Render the date for a current fact's `since` label. Uses the effective
 * timestamp (validAt → createdAt) and emits an ISO date string
 * (`YYYY-MM-DD`); falls back to `unknown` if neither is available.
 */
function formatSince(memory: Memory): string {
	const ts = readEffectiveTimestampMs(memory);
	if (ts === null) return "unknown";
	return new Date(ts).toISOString().slice(0, 10);
}

function readCategory(memory: Memory): string {
	const category = readFactMetadata(memory).category;
	if (typeof category === "string" && category.length > 0) return category;
	return "uncategorized";
}

function formatDurableLine(memory: Memory): string {
	const text = memory.content.text ?? "";
	if (!text) return "";
	const confidence = readFactConfidence(memory).toFixed(2);
	const category = readCategory(memory);
	return `[durable.${category} conf=${confidence}] ${text}`;
}

function formatCurrentLine(memory: Memory): string {
	const text = memory.content.text ?? "";
	if (!text) return "";
	const confidence = readFactConfidence(memory).toFixed(2);
	const category = readCategory(memory);
	const since = formatSince(memory);
	return `[current.${category} since ${since} conf=${confidence}] ${text}`;
}

function formatLines(memories: Memory[], kind: FactKind): string {
	const lines: string[] = [];
	for (const memory of memories) {
		const line =
			kind === "durable"
				? formatDurableLine(memory)
				: formatCurrentLine(memory);
		if (line) lines.push(line);
	}
	return lines.join("\n");
}

/**
 * Function to get key facts that the agent knows about the speaker.
 * Splits retrieval into two parallel similarity searches and ranks each
 * kind with its own time-weighting curve (see `fact-memory.md`).
 */
const factsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const recentMessages = await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				limit: 10,
				unique: false,
			});

			// Build the embedding seed from the most recent five message bodies.
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

			const embedding = await withTimeout(
				runtime.useModel(ModelType.TEXT_EMBEDDING, {
					text: last5Messages,
				}),
				EMBEDDING_TIMEOUT_MS,
				"FACTS provider: embedding call",
			);

			// Two parallel searches, one room-scoped and one entity-scoped, both
			// over the `facts` table. We over-fetch so that the in-memory kind
			// partition still leaves enough candidates per kind after filtering.
			// The runtime search API does not accept metadata filters today, so
			// the partition happens in TS below.
			//
			// We deliberately omit `query` here. Passing a query triggers BM25
			// lexical reranking inside `runtime.searchMemories`, which silently
			// drops candidates with zero token overlap and short-circuits the
			// embedding-similarity ranking we already rely on. The provider
			// re-ranks by `confidence × timeWeight(kind, age)` immediately
			// afterward, so adding a lexical filter on top would just hide
			// otherwise-relevant facts.
			const relatedEntityIds = await getRelatedEntityIds(
				runtime,
				message.entityId,
			);
			const [roomFacts, ...entityFactPools] = await Promise.all([
				runtime.searchMemories({
					tableName: "facts",
					embedding,
					roomId: message.roomId,
					worldId: message.worldId,
					limit: CANDIDATE_POOL_PER_SEARCH,
				}),
				...relatedEntityIds.map((entityId) =>
					runtime.searchMemories({
						embedding,
						tableName: "facts",
						entityId,
						limit: CANDIDATE_POOL_PER_SEARCH,
					}),
				),
			]);
			const entityFacts = entityFactPools.flat();

			const dedupedPool = dedupeById([...roomFacts, ...entityFacts]);
			const { durable: durableCandidates, current: currentCandidates } =
				partitionByKind(dedupedPool);

			const nowMs = Date.now();
			const durableFacts = rankByScore(
				durableCandidates,
				"durable",
				nowMs,
			).slice(0, TOP_PER_KIND);
			const currentFacts = rankByScore(
				currentCandidates,
				"current",
				nowMs,
			).slice(0, TOP_PER_KIND);
			const allFacts = [...durableFacts, ...currentFacts];

			if (allFacts.length === 0) {
				return {
					values: { facts: "" },
					data: {
						facts: allFacts,
						durableFacts,
						currentFacts,
					},
					text: "No facts available.",
				};
			}

			const agentName = runtime.character.name ?? "Agent";
			const senderName =
				(typeof message.content.senderName === "string" &&
					message.content.senderName) ||
				(typeof message.content.name === "string" && message.content.name) ||
				"the speaker";

			const sections: string[] = [];
			if (durableFacts.length > 0) {
				const durableHeader = `Things ${agentName} knows about ${senderName}:`;
				sections.push(
					`${durableHeader}\n${formatLines(durableFacts, "durable")}`,
				);
			}
			if (currentFacts.length > 0) {
				const currentHeader = `What's currently happening for ${senderName}:`;
				sections.push(
					`${currentHeader}\n${formatLines(currentFacts, "current")}`,
				);
			}

			const text = sections.join("\n\n");
			const formattedFacts = [
				formatLines(durableFacts, "durable"),
				formatLines(currentFacts, "current"),
			]
				.filter((part) => part.length > 0)
				.join("\n");

			return {
				values: { facts: formattedFacts },
				data: {
					facts: allFacts,
					durableFacts,
					currentFacts,
				},
				text,
			};
		} catch (error) {
			return {
				values: { facts: "" },
				data: {
					facts: [],
					durableFacts: [],
					currentFacts: [],
					error: error instanceof Error ? error.message : String(error),
				},
				text: "No facts available.",
			};
		}
	},
};

export { factsProvider };
