/**
 * FACTS provider: injects the durable and current facts the agent knows about
 * the speaker and the room into the prompt context. Pulls bounded recent
 * candidate pools from the `facts` memory table (one room-scoped, one per
 * related entity in the speaker's identity cluster), partitions them into
 * durable (identity-level, never decays) and current (time-decayed) kinds,
 * then ranks each kind locally with BM25 keyword scoring weighted by a
 * per-kind confidence × recency prior. Rendering attributes facts by
 * provenance — only sender-cluster facts appear under the "about the speaker"
 * header; room-pool facts about other participants render under a neutral
 * room header, so relay/webhook turns keep room recall without the room's
 * facts being misattributed to the bridge sender.
 * Retrieval deliberately avoids vector search so relevance is computed from the
 * fact's own words and extracted keywords; a keyword-miss on durable facts
 * falls back to the highest-prior candidates so direct recall still works.
 * Sender-owned `preference` facts get a separate bounded always-on lane
 * because standing preferences should be visible on every turn even with zero
 * lexical overlap ("brief replies" never BM25-matches "what's next?"); the
 * lane gate is structural (extractor-assigned category + ownership + prior),
 * and the responding model decides which surfaced preferences apply.
 */
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
import {
	buildFactQueryText,
	scoreFactKeywordRelevance,
} from "../fact-keywords.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("FACTS");

/**
 * Decay constant for `current` facts in the read-path ranking.
 *
 * Score = `confidence × exp(-ageDays / 14)` so a fact is at full weight on
 * day zero, ~50% at 14 days, and ~14% at 30 days. There is no hard cutoff —
 * very old current facts can still surface when relevance is high enough.
 * Durable facts skip decay entirely (`timeWeight = 1`).
 */
const CURRENT_DECAY_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_FACT_CONFIDENCE = 0.6;

/**
 * How many recent fact candidates we pull per scope before local BM25 keyword
 * scoring. SQL adapters currently do not consistently support metadata
 * filtering here, so we fetch a bounded recent pool and partition by
 * `metadata.kind` in TypeScript before ranking.
 */
const CANDIDATE_POOL_PER_SEARCH = 120;
const TOP_PER_KIND = 6;
const PRIVATE_FACT_PRIVACY_CLASSES = new Set([
	"private",
	"sensitive",
	"restricted",
	"owner_only",
	"owner-only",
]);
const PRIVATE_FACT_TEXT_PATTERN =
	/\b(?:confidential|sensitive|private|do not share|don't share|wants? (?:this|these|it|them) kept private|keep (?:this|these|it|them) private|kept private)\b/i;
const AVAILABILITY_REQUEST_PATTERN =
	/\b(?:availability|available|free|busy|calendar|schedule|meeting|call|book)\b/i;
const THIRD_PARTY_SCHEDULE_REFERENCE_PATTERN =
	/\b(?:your boss|boss'?s?|their schedule|his schedule|her schedule|around (?:their|his|her) schedule|someone else's calendar)\b/i;
const THIRD_PARTY_SELF_IDENTIFICATION_PATTERN =
	/\b(?:this is|it is|it's)\s+[^.!?\n]{1,80}\bfrom\b/i;
const THIRD_PARTY_NAMED_AVAILABILITY_PATTERN =
	/\b(?:(?:when\s+(?:is|can|could|would|will|does)|is|can|could|would|will|does)\s+(?!i\b|me\b|my\b|we\b|us\b|you\b|your\b|the\b|a\b|an\b)[a-z][a-z0-9'_-]{1,30}(?:\s+[a-z][a-z0-9'_-]{1,30}){0,2}\s+(?:free|available|busy|meet|join|take|do|have|book)|(?:availability|schedule|calendar)\s+for\s+(?!me\b|my\b|you\b|your\b)[a-z][a-z0-9'_-]{1,30}(?:\s+[a-z][a-z0-9'_-]{1,30}){0,2})\b/i;

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
 * carry no `kind` metadata; treat them as durable so existing identity-level
 * memories remain recallable.
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

function scoreFactPrior(memory: Memory, kind: FactKind, nowMs: number): number {
	const ts = readEffectiveTimestampMs(memory);
	const ageMs = ts === null ? 0 : Math.max(0, nowMs - ts);
	return readFactConfidence(memory) * timeWeight(kind, ageMs);
}

function rankByKeywordScore(
	memories: Memory[],
	kind: FactKind,
	queryText: string,
	nowMs: number,
): Memory[] {
	return scoreFactKeywordRelevance(queryText, memories)
		.map((entry) => ({
			memory: entry.memory,
			score: entry.relevance * scoreFactPrior(entry.memory, kind, nowMs),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score)
		.map((entry) => entry.memory);
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

function readStringMetadata(memory: Memory, key: string): string | null {
	const metadata = readFactMetadata(memory) as Record<string, unknown>;
	const value = metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function isMarkedPrivateFact(memory: Memory): boolean {
	const privacyClass =
		readStringMetadata(memory, "privacyClass") ??
		readStringMetadata(memory, "privacy_class") ??
		readStringMetadata(memory, "visibility") ??
		readStringMetadata(memory, "scope");
	if (
		privacyClass &&
		PRIVATE_FACT_PRIVACY_CLASSES.has(privacyClass.trim().toLowerCase())
	) {
		return true;
	}
	const text = memory.content.text ?? "";
	return PRIVATE_FACT_TEXT_PATTERN.test(text);
}

function shouldMinimizePrivateFactsForTurn(message: Memory): boolean {
	const text = message.content.text ?? "";
	return (
		AVAILABILITY_REQUEST_PATTERN.test(text) &&
		(THIRD_PARTY_SCHEDULE_REFERENCE_PATTERN.test(text) ||
			THIRD_PARTY_SELF_IDENTIFICATION_PATTERN.test(text) ||
			THIRD_PARTY_NAMED_AVAILABILITY_PATTERN.test(text))
	);
}

// Bounded always-on lane for the sender's stored `preference` facts. The gate
// is purely structural (extractor-assigned category + sender ownership +
// prior), never a keyword sniff of the fact text: the extractor LLM decided at
// write time that the row is a preference, and the responding model decides at
// read time which of the (≤3) surfaced preferences applies to this turn.
const PREFERENCE_LANE_LIMIT = 3;

function isPreferenceFact(memory: Memory): boolean {
	return readCategory(memory) === "preference";
}

function topByPrior(
	memories: Memory[],
	kind: FactKind,
	nowMs: number,
	limit: number,
): Memory[] {
	return [...memories]
		.sort(
			(left, right) =>
				scoreFactPrior(right, kind, nowMs) - scoreFactPrior(left, kind, nowMs),
		)
		.slice(0, limit);
}

function mergeAlwaysIncludedFacts(
	alwaysIncluded: Memory[],
	ranked: Memory[],
	max: number,
): Memory[] {
	return dedupeById([...alwaysIncluded, ...ranked]).slice(0, max);
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
 * Splits retrieval into room/entity candidate pools, performs local BM25
 * keyword scoring over fact text + extracted keywords, and ranks each kind
 * with its own time-weighting curve.
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

			// Build the lexical query from the current message and recent context.
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
			const queryText = buildFactQueryText(
				message.content.text ?? "",
				last5Messages,
			);

			if (!queryText) {
				return {
					values: { facts: "" },
					data: {
						facts: [],
						durableFacts: [],
						currentFacts: [],
					},
					text: "No facts available.",
				};
			}

			// Two parallel candidate fetches, one room-scoped and one entity-scoped,
			// both over the `facts` table. We intentionally use `getMemories`
			// instead of vector search: relevance is computed locally from extracted
			// fact keywords and the fact's own words.
			//
			// The room pool is fetched for every sender, automated or human: relay
			// webhooks and bridge bots carry real human conversation, so dropping
			// the room pool for them would zero out fact recall on exactly those
			// turns. Misattribution is prevented at render time instead — facts
			// are attributed by provenance, so room facts about other participants
			// never render under the sender's header.
			const relatedEntityIds = await getRelatedEntityIds(
				runtime,
				message.entityId,
			);
			const [roomFacts, ...entityFactPools] = await Promise.all([
				runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					worldId: message.worldId,
					count: CANDIDATE_POOL_PER_SEARCH,
					unique: false,
				}),
				...relatedEntityIds.map((entityId) =>
					runtime.getMemories({
						tableName: "facts",
						entityId,
						count: CANDIDATE_POOL_PER_SEARCH,
						unique: false,
					}),
				),
			]);
			const entityFacts = entityFactPools.flat();

			const minimizePrivateFacts = shouldMinimizePrivateFactsForTurn(message);
			const dedupedPool = dedupeById([...roomFacts, ...entityFacts]).filter(
				(memory) => !minimizePrivateFacts || !isMarkedPrivateFact(memory),
			);
			const { durable: durableCandidates, current: currentCandidates } =
				partitionByKind(dedupedPool);

			const nowMs = Date.now();
			const senderEntityIds = new Set<string>(relatedEntityIds);
			const isAboutSender = (memory: Memory): boolean =>
				typeof memory.entityId === "string" &&
				senderEntityIds.has(memory.entityId);
			let durableFacts = rankByKeywordScore(
				durableCandidates,
				"durable",
				queryText,
				nowMs,
			).slice(0, TOP_PER_KIND);
			// Durable facts are identity-level claims ("my dog's name is Jeff",
			// "my car is named Bertha") and few in number. Keyword/BM25 ranking
			// against the current message drops them whenever the question does
			// not lexically overlap the stored fact — e.g. "whats my cars name?"
			// vs "my car's name is Bertha" (no stemming for cars->car, and the
			// shared term "name" has ~0 IDF across a small pool), which scores 0
			// and hides a fact the user is directly asking to recall. When
			// relevance ranking surfaces no durable facts, fall back to the
			// highest-prior durable facts (confidence × recency, via
			// scoreFactPrior) so direct recall still works and a high-confidence
			// identity fact is preferred over a newer low-confidence one. Bounded
			// to TOP_PER_KIND, so this never floods the prompt.
			if (durableFacts.length === 0 && durableCandidates.length > 0) {
				durableFacts = [...durableCandidates]
					.sort(
						(left, right) =>
							scoreFactPrior(right, "durable", nowMs) -
							scoreFactPrior(left, "durable", nowMs),
					)
					.slice(0, TOP_PER_KIND);
			}
			const preferenceLane = topByPrior(
				durableCandidates.filter(
					(memory) => isAboutSender(memory) && isPreferenceFact(memory),
				),
				"durable",
				nowMs,
				PREFERENCE_LANE_LIMIT,
			);
			durableFacts = mergeAlwaysIncludedFacts(
				preferenceLane,
				durableFacts,
				TOP_PER_KIND + PREFERENCE_LANE_LIMIT,
			);
			const currentFacts = rankByKeywordScore(
				currentCandidates,
				"current",
				queryText,
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

			// Attribute by provenance: only facts stored against the sender's
			// identity cluster are "about the speaker". The room pool also carries
			// facts about OTHER participants — rendering those under the speaker
			// header told the model that facts about other people described
			// whoever happened to send the current message (worst on relay/webhook
			// turns, where every room fact got attributed to the bridge bot).
			const preferenceLaneIds = new Set(
				preferenceLane.map((memory) => memory.id),
			);
			const senderPreferences = durableFacts.filter((memory) =>
				preferenceLaneIds.has(memory.id),
			);
			const senderDurable = durableFacts.filter(
				(memory) => isAboutSender(memory) && !preferenceLaneIds.has(memory.id),
			);
			const roomDurable = durableFacts.filter((m) => !isAboutSender(m));
			const senderCurrent = currentFacts.filter(isAboutSender);
			const roomCurrent = currentFacts.filter((m) => !isAboutSender(m));

			const sections: string[] = [];
			if (senderPreferences.length > 0) {
				sections.push(
					`Standing preferences ${senderName} has expressed (apply any that are relevant to this reply):\n${formatLines(senderPreferences, "durable")}`,
				);
			}
			if (senderDurable.length > 0) {
				const durableHeader = `Things ${agentName} knows about ${senderName}:`;
				sections.push(
					`${durableHeader}\n${formatLines(senderDurable, "durable")}`,
				);
			}
			if (senderCurrent.length > 0) {
				const currentHeader = `What's currently happening for ${senderName}:`;
				sections.push(
					`${currentHeader}\n${formatLines(senderCurrent, "current")}`,
				);
			}
			if (roomDurable.length > 0) {
				sections.push(
					`Known facts in this room (about other participants):\n${formatLines(roomDurable, "durable")}`,
				);
			}
			if (roomCurrent.length > 0) {
				sections.push(
					`What's currently happening in this room:\n${formatLines(roomCurrent, "current")}`,
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
