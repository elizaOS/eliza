/**
 * Voice-attribution helpers: bind a voice-imprint observation to an
 * Entity (creating one if no match), extract name claims from
 * utterance text, and resolve pending relationships when a previously-
 * named partner finally speaks.
 *
 * Read R2-speaker.md §7 for the "Jill scenario" semantics that this
 * module exists to implement.
 */

import type { EntityStore } from "./store.js";
import type { SELF_ENTITY_ID } from "./types.js";

/**
 * Regex-first extractor of a self-name claim in an utterance.
 *
 * Covers:
 *   - "I'm Jill"           / "I am Jill"
 *   - "My name is Jill"
 *   - "This is Jill"
 *   - "Hey there, I'm Jill"
 *   - "Hi, it's Jill"
 *
 * Returns the captured name (untrimmed of trailing punctuation by
 * design — let the caller normalize) or `null` when the regex misses.
 * The R2 spec calls for an LLM fallback when the regex misses; that
 * fallback is wired in `voice-observer.ts` so this module stays
 * dependency-free for unit testing.
 */
// Trigger phrases ("my name is", "i'm", "this is", ...) match common ASR
// casing variants explicitly. The captured name stays anchored on an uppercase
// first letter to filter lowercased noise; JavaScript RegExp does not support
// scoped flag groups such as `(?-i:...)`.
const NAME_PATTERN = "[A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2}";
const NAME_CLAIM_PATTERNS: RegExp[] = [
  new RegExp(`\\b[Mm]y\\s+name\\s+is\\s+(${NAME_PATTERN})\\b`),
  new RegExp(`\\b[Ii]\\s+am\\s+(${NAME_PATTERN})\\b`),
  new RegExp(`\\b[Ii]['’]?m\\s+(${NAME_PATTERN})\\b`),
  new RegExp(`\\b[Tt]his\\s+is\\s+(${NAME_PATTERN})\\b`),
  new RegExp(`\\b[Ii]t['’]?s\\s+(${NAME_PATTERN})\\b`),
];

export function extractSelfNameClaim(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  for (const pattern of NAME_CLAIM_PATTERNS) {
    const m = pattern.exec(text);
    if (m?.[1]) {
      const cleaned = m[1].replace(/[.,;:!?]+$/, "").trim();
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}

/**
 * Extract a "<owner> says <name> is my <label>" assertion.
 *
 * Covers:
 *   - "Jill is my wife"            → {name:"Jill", label:"wife"}
 *   - "this is Jill, my wife"      → {name:"Jill", label:"wife"}
 *   - "Bob is my husband"          → {name:"Bob",  label:"husband"}
 *   - "Sam is my partner"
 *
 * Returns the first match; multi-relationship sentences are rare
 * enough to warrant punting until we have a real classifier.
 */
const PARTNER_LABELS = [
  "wife",
  "husband",
  "spouse",
  "partner",
  "girlfriend",
  "boyfriend",
  "fiance",
  "fiancée",
  "fiancé",
];

interface PartnerClaim {
  name: string;
  label: string;
  type: "partner_of";
}

const PARTNER_CLAIM_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  nameGroup: number;
  labelGroup: number;
}> = [
  {
    pattern: new RegExp(
      `\\b([A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2})\\s+is\\s+my\\s+(${PARTNER_LABELS.join("|")})\\b`,
      "i",
    ),
    nameGroup: 1,
    labelGroup: 2,
  },
  {
    pattern: new RegExp(
      `\\bthis\\s+is\\s+([A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2})\\s*,\\s*my\\s+(${PARTNER_LABELS.join("|")})\\b`,
      "i",
    ),
    nameGroup: 1,
    labelGroup: 2,
  },
];

export function extractPartnerClaim(
  text: string | null | undefined,
): PartnerClaim | null {
  if (!text) return null;
  for (const { pattern, nameGroup, labelGroup } of PARTNER_CLAIM_PATTERNS) {
    const m = pattern.exec(text);
    if (m?.[nameGroup] && m[labelGroup]) {
      const name = m[nameGroup].replace(/[.,;:!?]+$/, "").trim();
      const label = m[labelGroup].toLowerCase();
      if (name.length > 0) {
        return { name, label, type: "partner_of" };
      }
    }
  }
  return null;
}

export interface PendingRelationship {
  type: "partner_of";
  fromEntityId: typeof SELF_ENTITY_ID;
  toName: string;
  label: string;
  evidenceId: string;
  createdAt: string;
}

/**
 * In-memory pending-relationship queue. The "Jill scenario" needs
 * cross-utterance state: Shaw says "this is Jill, Jill is my wife"
 * **before** Jill ever speaks, so we can't resolve the relationship
 * until Jill is known. The queue lives in process memory; the engine
 * persists it (when needed) by writing the source utterance evidence
 * id into the relationship audit log on resolution.
 */
export class PendingRelationshipQueue {
  private pending: PendingRelationship[] = [];

  enqueue(claim: PendingRelationship): void {
    // De-dupe by (toName, type) — the most recent claim wins.
    this.pending = this.pending.filter(
      (p) =>
        p.toName.toLowerCase() !== claim.toName.toLowerCase() ||
        p.type !== claim.type,
    );
    this.pending.push(claim);
  }

  resolveByName(name: string): PendingRelationship[] {
    const lower = name.toLowerCase();
    const resolved = this.pending.filter(
      (p) => p.toName.toLowerCase() === lower,
    );
    this.pending = this.pending.filter((p) => p.toName.toLowerCase() !== lower);
    return resolved;
  }

  all(): readonly PendingRelationship[] {
    return this.pending;
  }

  size(): number {
    return this.pending.length;
  }
}

/**
 * Result of binding a voice-imprint observation to an Entity.
 */
export interface BindVoiceTurnResult {
  entityId: string;
  wasCreated: boolean;
  resolvedClaimedName: string | null;
  pendingRelationships: PendingRelationship[];
}

/**
 * Bind a voice-imprint observation to an Entity. If the imprint match
 * resolves to an existing entity, returns that entity's id. Otherwise
 * tries to extract a self-name claim from the utterance; either way,
 * runs through `EntityStore.observeIdentity` with `platform:"voice"`.
 *
 * Pending-relationship resolution is delegated to the caller — the
 * caller pulls `result.pendingRelationships` and applies them.
 */
export async function bindVoiceTurnToEntity(args: {
  entityStore: EntityStore;
  pendingQueue: PendingRelationshipQueue;
  matchedEntityId: string | null;
  utteranceText: string;
  imprintClusterId: string;
  evidenceIds: string[];
  matchConfidence: number;
}): Promise<BindVoiceTurnResult> {
  if (args.matchedEntityId) {
    const resolved = args.pendingQueue.resolveByName(
      (await args.entityStore.get(args.matchedEntityId))?.preferredName ?? "",
    );
    return {
      entityId: args.matchedEntityId,
      wasCreated: false,
      resolvedClaimedName: null,
      pendingRelationships: resolved,
    };
  }
  const claimedName = extractSelfNameClaim(args.utteranceText);
  const result = await args.entityStore.observeIdentity({
    platform: "voice",
    handle: args.imprintClusterId,
    ...(claimedName ? { displayName: claimedName } : {}),
    evidence: args.evidenceIds,
    confidence: claimedName ? Math.max(0.7, args.matchConfidence) : 0.5,
    suggestedType: "person",
  });

  const pendingRelationships = claimedName
    ? args.pendingQueue.resolveByName(claimedName)
    : [];

  return {
    entityId: result.entity.entityId,
    wasCreated: result.mergedFrom === undefined,
    resolvedClaimedName: claimedName,
    pendingRelationships,
  };
}
