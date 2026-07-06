/**
 * Passive user-preference extraction evaluator (`preferences`) — the
 * conversational writer for the personality behavior loop (#14675). Runs
 * post-response beside the reflection evaluators and extracts, via one
 * strict-JSON-schema model call, preferences the user expressed in passing
 * ("ugh, that was way too long", "no emojis please", "I prefer morning
 * check-ins") — zero explicit input required.
 *
 * Writes route to the store that can already act on each kind, so no new
 * store or provider exists here. Closed-enum reply-style traits and custom
 * directives go to the PersonalityStore slot with source "agent_inferred";
 * `userPersonalityProvider` re-injects them into every prompt and verbosity is
 * hard-enforced in the reply callback. Domain / view / interaction-pattern
 * preferences land as durable `preference` facts in the facts table, consumed
 * by the FACTS provider and downstream systems (LifeOps scheduling, view
 * actions) exactly like fact-extractor rows.
 *
 * Safety invariants: inference never overwrites an explicitly-set trait —
 * gates read the per-trait provenance in `slot.trait_sources`, so explicit
 * beats inferred at any confidence and across turns (a lone inferred directive
 * write cannot relabel the slot and unlock a later overwrite). `reply_gate` is
 * never touched (silencing the agent off an inferred signal is a hazard; the
 * op is not even representable in the schema), and global scope is never
 * written. Trait gates read the slot snapshot taken before any write this run,
 * so one inferred write cannot change another op's gate in the same run.
 * On runtimes without the PersonalityStore service
 * (advanced capabilities off), the fact lane still works and slot ops are
 * dropped with a debug log — the counters in the processor result record it.
 */
import { v4 } from "uuid";
import { logger } from "../../../logger.ts";
import { EvaluatorPriority } from "../../../services/evaluator-priorities.ts";
import type {
	Evaluator,
	IAgentRuntime,
	JSONSchema,
	Memory,
	MemoryMetadata,
	RegisteredEvaluator,
	UUID,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import type { CustomMetadata, FactMetadata } from "../../../types/memory.ts";
import { MemoryType } from "../../../types/memory.ts";
import { isSyntheticConversationArtifactMemory } from "../../../utils/synthetic-conversation-artifact.ts";
import {
	buildFactKeywordsForStorage,
	buildFactSearchText,
	factLexicalSimilarity,
	readStoredFactKeywords,
} from "../fact-keywords.ts";
import {
	getPersonalityStore,
	type PersonalityStore,
} from "../personality/services/personality-store.ts";
import {
	FORMALITY_VALUES,
	type PersonalitySlot,
	TONE_VALUES,
	TRAIT_VALUES,
	VERBOSITY_VALUES,
} from "../personality/types.ts";
import {
	type AddDirectiveOp,
	type AddPreferenceFactOp,
	type PreferenceExtractorOutput,
	parsePreferenceOutputTolerant,
	type RetractTraitOp,
	type SetTraitOp,
} from "./preferenceExtractor.schema.ts";
import {
	canEvaluateMessage,
	DEDUP_SIMILARITY_THRESHOLD,
	formatRecentMessages,
	NEW_FACT_CONFIDENCE,
	preserveFactMetadata,
	STRENGTHEN_DELTA,
} from "./reflection-items.ts";

const RECENT_MESSAGES_LIMIT = 10;
const PREFERENCE_FACT_LOOKBACK = 60;
const MAX_KNOWN_PREFERENCES = 15;
// Slot writes shape EVERY subsequent prompt for this user (and verbosity is
// hard-enforced post-generation), so only high-confidence signals may touch
// the PersonalityStore. Preference facts have no gate — they go through the
// same dedupe/strengthen discipline as fact-extractor rows and only surface
// via ranked retrieval.
const SLOT_CONFIDENCE_THRESHOLD = 0.8;

const preferenceOpsSchema: JSONSchema = {
	type: "object",
	properties: {
		ops: {
			type: "array",
			items: {
				type: "object",
				properties: {
					op: {
						type: "string",
						enum: [
							"set_trait",
							"add_directive",
							"add_preference_fact",
							"retract_trait",
						],
					},
					trait: { type: "string", enum: [...TRAIT_VALUES] },
					// One flat enum across all three traits: a per-trait value union
					// is not expressible under the strict structured-output invariants
					// (see reflection-items.ts header). Trait/value pairing is
					// validated in parsePreferenceOutputTolerant instead.
					value: {
						type: "string",
						enum: [...VERBOSITY_VALUES, ...TONE_VALUES, ...FORMALITY_VALUES],
					},
					confidence: { type: "number" },
					evidence: { type: "string" },
					text: { type: "string" },
					claim: { type: "string" },
					// No maxItems: strict structured-output validators reject array
					// length constraints — the 16-keyword cap is enforced in code.
					keywords: {
						type: "array",
						items: { type: "string" },
					},
					reason: { type: "string" },
				},
				required: ["op"],
				additionalProperties: false,
			},
		},
	},
	required: ["ops"],
	additionalProperties: false,
};

export interface PreferencePrepared {
	recentMessages: Memory[];
	/** Null when the PersonalityStore service is not registered. */
	slot: PersonalitySlot | null;
	knownPreferenceFacts: Memory[];
}

function nowIso(): string {
	return new Date().toISOString();
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function isDurablePreferenceFact(memory: Memory): boolean {
	const meta = readFactMetadata(memory);
	return meta.category === "preference" && meta.kind !== "current";
}

function pickFactConfidence(memory: Memory): number {
	const value = readFactMetadata(memory).confidence;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return NEW_FACT_CONFIDENCE;
}

async function preparePreferences(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<PreferencePrepared> {
	const [recentMessagesRaw, entityFacts] = await Promise.all([
		runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: RECENT_MESSAGES_LIMIT,
			unique: false,
		}),
		runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			entityId: message.entityId,
			limit: PREFERENCE_FACT_LOOKBACK,
			unique: false,
		}),
	]);
	const recentMessages = recentMessagesRaw.filter(
		(memory) => !isSyntheticConversationArtifactMemory(memory),
	);
	const knownPreferenceFacts = entityFacts.filter(isDurablePreferenceFact);
	const store = getPersonalityStore(runtime);
	return {
		recentMessages,
		slot: store ? store.getSlot(message.entityId) : null,
		knownPreferenceFacts,
	};
}

function formatSlotForPrompt(slot: PersonalitySlot | null): string {
	if (!slot) return "(personality slot store unavailable)";
	const lines: string[] = [];
	if (slot.verbosity) lines.push(`- verbosity: ${slot.verbosity}`);
	if (slot.tone) lines.push(`- tone: ${slot.tone}`);
	if (slot.formality) lines.push(`- formality: ${slot.formality}`);
	slot.custom_directives.forEach((directive, index) => {
		lines.push(`- directive ${index + 1}: ${directive}`);
	});
	if (lines.length === 0) return "(none set)";
	lines.push(`- last set by: ${slot.source}`);
	return lines.join("\n");
}

function formatKnownPreferences(facts: Memory[]): string {
	const lines: string[] = [];
	for (const fact of facts.slice(0, MAX_KNOWN_PREFERENCES)) {
		const text = fact.content.text ?? "";
		if (text) lines.push(`- ${text}`);
	}
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

type SlotOpOutcome =
	| "applied"
	| "unchanged"
	| "skipped_low_confidence"
	| "skipped_explicit";

/**
 * Gates read per-trait provenance (`trait_sources[trait]`), never the
 * slot-level `source`: `source` records only the last writer, so one inferred
 * directive write would relabel the whole slot and unlock overwriting an
 * explicitly-set trait on a later turn. `gateSlot` is the pre-run snapshot so
 * one run's writes cannot change another op's gate inside the same run.
 */
async function applySetTrait(
	store: PersonalityStore,
	runtime: IAgentRuntime,
	userId: UUID,
	gateSlot: PersonalitySlot,
	op: SetTraitOp,
): Promise<SlotOpOutcome> {
	if (op.confidence < SLOT_CONFIDENCE_THRESHOLD)
		return "skipped_low_confidence";
	const current = gateSlot[op.trait];
	if (current === op.value) return "unchanged";
	if (
		current !== null &&
		gateSlot.trait_sources[op.trait] !== "agent_inferred"
	) {
		return "skipped_explicit";
	}
	await store.applyTrait({
		scope: "user",
		userId,
		agentId: runtime.agentId,
		actorId: runtime.agentId,
		trait: op.trait,
		value: op.value,
		source: "agent_inferred",
	});
	return "applied";
}

async function applyRetractTrait(
	store: PersonalityStore,
	runtime: IAgentRuntime,
	userId: UUID,
	gateSlot: PersonalitySlot,
	op: RetractTraitOp,
): Promise<SlotOpOutcome> {
	// Retraction only undoes inference. An explicitly-set trait (per-trait
	// source user/admin) is cleared through the PERSONALITY action, never by
	// the extractor.
	if (gateSlot[op.trait] === null) return "unchanged";
	if (gateSlot.trait_sources[op.trait] !== "agent_inferred") {
		return "skipped_explicit";
	}
	await store.applyTrait({
		scope: "user",
		userId,
		agentId: runtime.agentId,
		actorId: runtime.agentId,
		trait: op.trait,
		value: null,
		source: "agent_inferred",
	});
	return "applied";
}

async function applyAddDirective(
	store: PersonalityStore,
	runtime: IAgentRuntime,
	userId: UUID,
	op: AddDirectiveOp,
): Promise<"added" | "deduped" | "skipped_low_confidence"> {
	if (op.confidence < SLOT_CONFIDENCE_THRESHOLD)
		return "skipped_low_confidence";
	// Dedupe against the LIVE slot (unlike trait gates) so two near-identical
	// directives emitted in one run collapse to one entry.
	const existing = store.getSlot(userId, runtime.agentId).custom_directives;
	const isDuplicate = existing.some(
		(directive) =>
			factLexicalSimilarity([op.text], [directive]) >=
			DEDUP_SIMILARITY_THRESHOLD,
	);
	if (isDuplicate) return "deduped";
	await store.addDirective({
		userId,
		agentId: runtime.agentId,
		actorId: runtime.agentId,
		directive: op.text,
		source: "agent_inferred",
	});
	return "added";
}

interface FactCandidate {
	memory: Memory;
	searchText: string;
}

async function applyAddPreferenceFact(
	runtime: IAgentRuntime,
	message: Memory,
	candidates: FactCandidate[],
	op: AddPreferenceFactOp,
): Promise<{ added: boolean; strengthened: boolean }> {
	const keywords = buildFactKeywordsForStorage(
		op.keywords ?? [],
		op.claim,
		"preference",
	);
	const targetValues = [op.claim, "preference", keywords];
	let best: { memory: Memory; similarity: number } | null = null;
	for (const candidate of candidates) {
		const similarity = factLexicalSimilarity(targetValues, [
			candidate.searchText,
			readStoredFactKeywords(candidate.memory),
		]);
		if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
			if (!best || similarity > best.similarity) {
				best = { memory: candidate.memory, similarity };
			}
		}
	}
	if (best?.memory.id) {
		// Update-not-duplicate: a re-stated preference reinforces the existing
		// row instead of creating a near-copy the provider would rank twice.
		const nextMeta: CustomMetadata = {
			...preserveFactMetadata(best.memory),
			confidence: clamp01(pickFactConfidence(best.memory) + STRENGTHEN_DELTA),
			lastConfirmedAt: nowIso(),
		};
		await runtime.updateMemory({ id: best.memory.id, metadata: nextMeta });
		return { added: false, strengthened: true };
	}
	const metadata: MemoryMetadata = {
		type: MemoryType.CUSTOM,
		source: "preference_extractor",
		// The model's own confidence when it gave one (the schema advertises
		// it); the shared default only backfills its absence.
		confidence: clamp01(op.confidence ?? NEW_FACT_CONFIDENCE),
		lastConfirmedAt: nowIso(),
		kind: "durable",
		category: "preference",
		structuredFields: {},
		keywords,
		verificationStatus: "self_reported",
	};
	const memory: Memory = {
		id: asUUID(v4()),
		entityId: message.entityId,
		agentId: runtime.agentId,
		roomId: message.roomId,
		content: { text: op.claim },
		metadata,
		createdAt: Date.now(),
	};
	const persistedId = await runtime.createMemory(memory, "facts", true);
	if (persistedId) {
		candidates.push({ memory, searchText: buildFactSearchText(memory) });
	}
	return { added: persistedId != null, strengthened: false };
}

export const preferenceEvaluator: Evaluator<
	PreferenceExtractorOutput,
	PreferencePrepared
> = {
	name: "preferences",
	description:
		"Extracts user preferences about the agent, views, and interaction style from ordinary conversation.",
	priority: EvaluatorPriority.REFLECTION_PREFERENCES,
	schema: preferenceOpsSchema,
	async shouldRun({ runtime, message }) {
		// The agent's own messages carry no user preference signal, and
		// evaluating them would let the agent "infer" preferences from itself.
		return canEvaluateMessage(message) && message.entityId !== runtime.agentId;
	},
	async prepare({ runtime, message }) {
		return preparePreferences(runtime, message);
	},
	prompt({ runtime, prepared }) {
		const agentName = runtime.character.name ?? "Agent";
		// Without the PersonalityStore, slot ops would be dropped in the
		// processor anyway — don't advertise them, so the model routes
		// everything usable through the fact lane.
		const slotOps = prepared.slot
			? `- set_trait: reply style that clearly maps to a closed trait value. verbosity: terse|normal|verbose. tone: warm|neutral|direct|cold. formality: casual|professional|formal.
- add_directive: standing reply-style rule with no trait mapping ("no emojis", "one question at a time", "don't stack messages"). Short imperative text, max 200 chars.
- retract_trait: the user pushes back on an inferred trait shown below.
`
			: "";
		const complaintExample = prepared.slot
			? '"ugh, way too long" -> set_trait verbosity=terse'
			: '"ugh, way too long" -> add_preference_fact "prefers short replies"';
		return `Find preferences the user expressed about how ${agentName} should behave or how they want to interact. Passive signals count: complaints (${complaintExample}), asides, repeated corrections — not just direct requests.

Ops:
${slotOps}- add_preference_fact: preferences that are knowledge rather than reply style — views/UI (theme, background, widgets), content, timing ("morning check-ins", "quiet hours after 10pm"), interaction patterns ("prefers chat over views", "reads slowly, wants time to think"). claim + 3-8 lowercase retrieval keywords.

Rules:
- Only the speaker's own expressed preferences. Not the agent's suggestions, not hypotheticals, not third parties.
- confidence 0-1, honest; slot ops below 0.8 are discarded.
- No preference expressed -> {"ops":[]}.
- Never emit anything about muting, ignoring, or when ${agentName} may reply.

Current personality for this user:
${formatSlotForPrompt(prepared.slot)}

Known preferences already stored:
${formatKnownPreferences(prepared.knownPreferenceFacts)}

Recent messages:
${formatRecentMessages(prepared.recentMessages)}`;
	},
	parse(output) {
		// Tolerant, op-by-op — drops are logged inside
		// parsePreferenceOutputTolerant (this parse contract has no
		// runtime/logger). Null only when the envelope isn't { ops: [...] }.
		return parsePreferenceOutputTolerant(output);
	},
	processors: [
		{
			name: "applyPreferenceOps",
			async process({ runtime, message, prepared, output }) {
				const store = getPersonalityStore(runtime);
				const userId = message.entityId;
				// Pre-run snapshot for trait gates — see applySetTrait.
				const gateSlot = store ? store.getSlot(userId) : null;
				// Re-fetch dedupe candidates at process() time: the fact evaluator
				// (priority 100) runs in the same merged post-turn call BEFORE this
				// processor and may have just inserted `preference` rows the
				// prepare-time snapshot cannot see — deduping against the snapshot
				// would double-store the same preference in one turn.
				const hasFactOps = output.ops.some(
					(op) => op.op === "add_preference_fact",
				);
				const freshFacts = hasFactOps
					? (
							await runtime.getMemories({
								tableName: "facts",
								roomId: message.roomId,
								entityId: message.entityId,
								limit: PREFERENCE_FACT_LOOKBACK,
								unique: false,
							})
						).filter(isDurablePreferenceFact)
					: prepared.knownPreferenceFacts;
				const candidates: FactCandidate[] = freshFacts.map((memory) => ({
					memory,
					searchText: buildFactSearchText(memory),
				}));
				let traitsSet = 0;
				let traitsRetracted = 0;
				let directivesAdded = 0;
				let factsAdded = 0;
				let factsStrengthened = 0;
				let skipped = 0;
				let droppedNoStore = 0;
				for (const op of output.ops) {
					if (op.op === "add_preference_fact") {
						const result = await applyAddPreferenceFact(
							runtime,
							message,
							candidates,
							op,
						);
						if (result.added) factsAdded += 1;
						if (result.strengthened) factsStrengthened += 1;
						continue;
					}
					if (!store || !gateSlot) {
						droppedNoStore += 1;
						continue;
					}
					if (op.op === "set_trait") {
						const outcome = await applySetTrait(
							store,
							runtime,
							userId,
							gateSlot,
							op,
						);
						if (outcome === "applied") traitsSet += 1;
						else skipped += 1;
						continue;
					}
					if (op.op === "add_directive") {
						const outcome = await applyAddDirective(store, runtime, userId, op);
						if (outcome === "added") directivesAdded += 1;
						else skipped += 1;
						continue;
					}
					const outcome = await applyRetractTrait(
						store,
						runtime,
						userId,
						gateSlot,
						op,
					);
					if (outcome === "applied") traitsRetracted += 1;
					else skipped += 1;
				}
				if (droppedNoStore > 0) {
					// Expected on runtimes without advanced capabilities (the store is
					// a config choice, not a broken pipeline) — debug, not warn, and
					// the counters below keep it visible in trajectories.
					logger.debug(
						{ src: "preferences", droppedNoStore },
						"PersonalityStore unavailable; dropped slot ops",
					);
				}
				const counters = {
					traitsSet,
					traitsRetracted,
					directivesAdded,
					factsAdded,
					factsStrengthened,
					skipped,
					droppedNoStore,
				};
				return { success: true, values: counters, data: counters };
			},
		},
	],
};

export const preferenceItems: RegisteredEvaluator[] = [preferenceEvaluator];
