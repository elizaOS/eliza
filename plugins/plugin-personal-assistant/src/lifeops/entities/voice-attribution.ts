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
const NAME_PATTERN =
  "[A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2}";
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
 * Extract a "<owner> says <name> is my <label>" kin assertion.
 *
 * Covers partner AND sibling claims (issue #10726: "my sister Joan" was not
 * extractable on the voice path):
 *   - "Jill is my wife"            → {name:"Jill", label:"wife",   type:"partner_of"}
 *   - "this is Jill, my wife"      → {name:"Jill", label:"wife",   type:"partner_of"}
 *   - "Sam is my partner"          → {name:"Sam",  label:"partner",type:"partner_of"}
 *   - "this is my wife Jill"       → {name:"Jill", label:"wife",   type:"partner_of"}
 *   - "my husband Bob just called" → {name:"Bob",  label:"husband",type:"partner_of"}
 *   - "Joan is my sister"          → {name:"Joan", label:"sister", type:"sibling_of"}
 *   - "my brother Bob just called" → {name:"Bob",  label:"brother",type:"sibling_of"}
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

const SIBLING_LABELS = ["sister", "brother", "sibling"];

/** Open-string relationship types are supported by design (shared registry). */
export type KinClaimType = "partner_of" | "sibling_of";

const KIN_LABELS = [...PARTNER_LABELS, ...SIBLING_LABELS];

function kinTypeForLabel(label: string): KinClaimType {
  return SIBLING_LABELS.includes(label) ? "sibling_of" : "partner_of";
}

export interface KinClaim {
  name: string;
  label: string;
  type: KinClaimType;
}

const KIN_CLAIM_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  nameGroup: number;
  labelGroup: number;
}> = [
  {
    pattern: new RegExp(
      `\\b([A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2})\\s+is\\s+my\\s+(${KIN_LABELS.join("|")})\\b`,
      "i",
    ),
    nameGroup: 1,
    labelGroup: 2,
  },
  {
    pattern: new RegExp(
      `\\bthis\\s+is\\s+([A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2})\\s*,\\s*my\\s+(${KIN_LABELS.join("|")})\\b`,
      "i",
    ),
    nameGroup: 1,
    labelGroup: 2,
  },
  // Label-before-name phrasing: "this is my <label> <name>" / "my <label>
  // <name>". Capture a SINGLE trailing name token so it can't swallow the
  // following verb ("my husband Bob just called" → "Bob", not "Bob just").
  {
    pattern: new RegExp(
      `\\b(?:this\\s+is\\s+)?my\\s+(${KIN_LABELS.join("|")})\\s+([A-Z][A-Za-z'.-]{1,40})\\b`,
      "i",
    ),
    nameGroup: 2,
    labelGroup: 1,
  },
];

// Words that a name regex can capture but that never denote a real person.
// Applied to the captured NAME so a matched-but-invalid candidate (e.g.
// "this is my wife Jill" matching name="this" via the "<name> is my <label>"
// pattern) is skipped and the loop continues to a better pattern.
const NAME_STOPWORDS = new Set([
  "this",
  "that",
  "it",
  "he",
  "she",
  "they",
  "here",
  "there",
  "is",
  "was",
  "the",
  "my",
  "a",
  "an",
  "and",
]);

export function extractKinClaim(
  text: string | null | undefined,
): KinClaim | null {
  if (!text) return null;
  for (const { pattern, nameGroup, labelGroup } of KIN_CLAIM_PATTERNS) {
    const m = pattern.exec(text);
    if (m?.[nameGroup] && m[labelGroup]) {
      const name = m[nameGroup].replace(/[.,;:!?]+$/, "").trim();
      const label = m[labelGroup].toLowerCase();
      if (name.length > 0 && !NAME_STOPWORDS.has(name.toLowerCase())) {
        return { name, label, type: kinTypeForLabel(label) };
      }
    }
  }
  return null;
}

/**
 * Extract a spoken self-affiliation claim that should bind the SPEAKING
 * entity to an organization via `works_at` (issue #10726: "I'm John from
 * accounting" carried no affiliation on the voice path; `works_at` existed
 * only in the text pipeline `lifeops/relationships/extraction.ts`).
 *
 * Covers:
 *   - "I'm John from the accounting team" → {name:"John", organization:"accounting team"}
 *   - "This is Ada from Payroll"          → {name:"Ada",  organization:"Payroll"}
 *   - "I work at Acme Corp"               → {name:null,   organization:"Acme Corp"}
 *   - "I work for the city council"       → {name:null,   organization:"city council"}
 *
 * The name anchor stays uppercase-first (same heuristic as the self-name
 * claim) so "I'm calling from the airport" never minted an affiliation.
 */
export interface SelfAffiliationClaim {
  name: string | null;
  organization: string;
}

const ORG_PHRASE = "[A-Za-z][A-Za-z0-9&'’. -]{1,60}";

const AFFILIATION_WITH_NAME_PATTERN = new RegExp(
  `\\b(?:[Ii]['’]?m|[Ii]\\s+am|[Tt]his\\s+is)\\s+(${NAME_PATTERN})\\s+(?:from|with)\\s+(?:the\\s+)?(${ORG_PHRASE})`,
);

const WORKS_AT_PATTERN = new RegExp(
  `\\b[Ii]\\s+work\\s+(?:at|for)\\s+(?:the\\s+)?(${ORG_PHRASE})`,
);

/** Words that mark a phrase as an organization/department reference. */
const ORG_KEYWORD_PATTERN =
  /\b(?:team|department|dept|group|office|company|corp|corporation|inc|llc|ltd|council|division|lab|labs|university|college|hospital|clinic|agency|firm|bank|studio|store|school|bureau|institute)\b/i;

/** Single lowercase tokens that read like places, not departments. */
const ORG_TOKEN_STOPWORDS = new Set([
  "work",
  "home",
  "town",
  "here",
  "there",
  "abroad",
  "overseas",
  "upstairs",
  "downstairs",
  "outside",
]);

function cleanOrganization(raw: string): string | null {
  let cleaned = raw
    .replace(/[.,;:!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // The org phrase ends where the sentence moves on ("...from the accounting
  // team and I need help with...").
  const clauseBreak = cleaned.search(
    /\s+(?:and|but|so|because|who|which|where|when|about)\b/i,
  );
  if (clauseBreak > 0) cleaned = cleaned.slice(0, clauseBreak).trim();
  cleaned = cleaned.replace(/[.,;:!?]+$/, "").trim();
  if (cleaned.length < 2) return null;
  if (NAME_STOPWORDS.has(cleaned.toLowerCase())) return null;
  // Cap runaway captures: an org phrase longer than five words is almost
  // certainly the rest of the sentence, not an organization name.
  if (cleaned.split(" ").length > 5) return null;
  // Plausibility gate — keeps "I'm Jill with the long hair" from minting a
  // "long hair" organization. Accept: proper-noun orgs ("Acme Corp",
  // "Payroll"), phrases with an org keyword ("accounting team"), or a single
  // lowercase department-style token ("accounting").
  const words = cleaned.split(" ");
  const properNoun = /^[A-Z]/.test(cleaned);
  const hasOrgKeyword = ORG_KEYWORD_PATTERN.test(cleaned);
  const singleDepartmentToken =
    words.length === 1 && !ORG_TOKEN_STOPWORDS.has(cleaned.toLowerCase());
  if (!properNoun && !hasOrgKeyword && !singleDepartmentToken) return null;
  return cleaned;
}

export function extractSelfAffiliationClaim(
  text: string | null | undefined,
): SelfAffiliationClaim | null {
  if (!text) return null;
  const withName = AFFILIATION_WITH_NAME_PATTERN.exec(text);
  if (withName?.[1] && withName[2]) {
    const name = withName[1].replace(/[.,;:!?]+$/, "").trim();
    const organization = cleanOrganization(withName[2]);
    if (organization && !NAME_STOPWORDS.has(name.toLowerCase())) {
      return { name, organization };
    }
  }
  const worksAt = WORKS_AT_PATTERN.exec(text);
  if (worksAt?.[1]) {
    const organization = cleanOrganization(worksAt[1]);
    if (organization) return { name: null, organization };
  }
  return null;
}

export interface PendingRelationship {
  type: KinClaimType;
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
