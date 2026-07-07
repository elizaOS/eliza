/**
 * Gathers implicit-referent candidates from the owner's real memory stores so
 * `resolveImplicitReferent` ranks live data, not fixtures.
 *
 * Candidates come from two existing stores — no new store is introduced:
 *   - the `facts` memory table (free-form durable/current owner facts), which is
 *     also what the core FACTS provider reads; and
 *   - the {@link OwnerFactStore} scalar record (preferred name, travel
 *     preferences, notification channel), which carries the owner's typed
 *     policy/preference facts.
 *
 * The `prior` the resolver consumes as its semantic-relevance signal is taken
 * from each candidate's own persisted signal, never fabricated: a fact memory
 * retrieved via semantic search carries `similarity`; absent that, its stored
 * `metadata.confidence` is the honest per-fact weight. When neither exists the
 * `prior` is simply omitted and the resolver ranks on its lexical/signal terms
 * alone. Richer embedding/BM25 retrieval (the standing-preferences lane) will
 * populate `similarity` on more candidates without changing this contract.
 */

import type { FactMetadata, IAgentRuntime, Memory } from "@elizaos/core";
import { resolveOwnerFactStore } from "../owner/fact-store.js";
import type {
  ImplicitReferentCandidate,
  ImplicitReferentSource,
} from "./index.js";

/** How many recent fact memories to pull before the resolver ranks them. */
const FACT_CANDIDATE_LIMIT = 40;

/**
 * Read a fact memory's metadata as {@link FactMetadata}. Fact-table rows store
 * the fact shape, but `Memory.metadata` is typed as the message-oriented union,
 * so a narrow is required — the same access the core FACTS provider performs.
 */
function factMetadata(memory: Memory): FactMetadata {
  const meta = memory.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return meta as FactMetadata;
}

function factText(memory: Memory): string {
  const text = memory.content.text;
  return typeof text === "string" ? text.trim() : "";
}

/**
 * The semantic-relevance prior for a fact memory. `similarity` is set by the
 * adapter only when the fact was retrieved via embedding search; `confidence`
 * is the persisted extractor weight. Both are genuine [0,1] signals — we never
 * substitute a literal for a missing one, so an unranked fact simply has no
 * prior.
 */
function factPrior(memory: Memory): number | undefined {
  if (
    typeof memory.similarity === "number" &&
    Number.isFinite(memory.similarity)
  ) {
    return memory.similarity;
  }
  const confidence = factMetadata(memory).confidence;
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    return confidence;
  }
  return undefined;
}

function factTags(memory: Memory): string[] | undefined {
  const keywords = factMetadata(memory).keywords;
  if (!Array.isArray(keywords)) return undefined;
  const tags = keywords.filter(
    (keyword): keyword is string =>
      typeof keyword === "string" && keyword.length > 0,
  );
  return tags.length > 0 ? tags : undefined;
}

function factOccurredAt(memory: Memory): string | undefined {
  const validAt = factMetadata(memory).validAt;
  if (typeof validAt === "string" && Number.isFinite(Date.parse(validAt))) {
    return validAt;
  }
  if (
    typeof memory.createdAt === "number" &&
    Number.isFinite(memory.createdAt)
  ) {
    return new Date(memory.createdAt).toISOString();
  }
  return undefined;
}

function factToCandidate(
  memory: Memory,
  index: number,
): ImplicitReferentCandidate | null {
  const summary = factText(memory);
  if (!summary) return null;
  const source: ImplicitReferentSource = "owner_fact";
  const label =
    summary.length > 60 ? `${summary.slice(0, 59).trimEnd()}…` : summary;
  const prior = factPrior(memory);
  const tags = factTags(memory);
  const occurredAt = factOccurredAt(memory);
  return {
    id: memory.id ?? `fact:${index}`,
    source,
    label,
    summary,
    confirmation: summary,
    ...(tags ? { tags } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    ...(prior !== undefined ? { prior } : {}),
  };
}

/**
 * Project the owner's scalar preference facts (travel + notification channel)
 * into referent candidates. These are the standing "the usual" preferences a
 * bare owner ask most often points at, and they live in {@link OwnerFactStore},
 * not the fact memory table.
 */
async function ownerPreferenceCandidates(
  runtime: IAgentRuntime,
): Promise<ImplicitReferentCandidate[]> {
  const facts = await resolveOwnerFactStore(runtime).read();
  const candidates: ImplicitReferentCandidate[] = [];
  if (facts.travelBookingPreferences) {
    candidates.push({
      id: "owner-fact:travelBookingPreferences",
      source: "owner_fact",
      label: "usual travel booking preferences",
      summary: facts.travelBookingPreferences.value,
      confirmation: `using your usual travel preferences (${facts.travelBookingPreferences.value})`,
      tags: ["usual", "travel"],
      occurredAt: facts.travelBookingPreferences.provenance.recordedAt,
    });
  }
  if (facts.preferredNotificationChannel) {
    candidates.push({
      id: "owner-fact:preferredNotificationChannel",
      source: "owner_fact",
      label: "preferred notification channel",
      summary: `Owner prefers ${facts.preferredNotificationChannel.value} for notifications.`,
      confirmation: `sending it via your usual channel (${facts.preferredNotificationChannel.value})`,
      tags: ["usual", "channel"],
      occurredAt: facts.preferredNotificationChannel.provenance.recordedAt,
    });
  }
  return candidates;
}

/**
 * Assemble the candidate set for an implicit owner ask from the fact memory
 * table and the owner-fact store. The caller passes the result straight to
 * {@link resolveImplicitReferent}.
 */
export async function gatherImplicitReferentCandidates(
  runtime: IAgentRuntime,
): Promise<ImplicitReferentCandidate[]> {
  const factMemories = await runtime.getMemories({
    tableName: "facts",
    agentId: runtime.agentId,
    count: FACT_CANDIDATE_LIMIT,
    includeEmbedding: false,
  });
  const factCandidates = factMemories
    .map((memory, index) => factToCandidate(memory, index))
    .filter(
      (candidate): candidate is ImplicitReferentCandidate => candidate !== null,
    );
  const preferenceCandidates = await ownerPreferenceCandidates(runtime);
  return [...preferenceCandidates, ...factCandidates];
}
