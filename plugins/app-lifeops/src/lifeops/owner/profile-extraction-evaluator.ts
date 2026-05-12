import { hasOwnerAccess } from "@elizaos/agent";
import type {
  ResponseHandlerEvaluator,
  ResponseHandlerPatch,
} from "@elizaos/core";
import { EntityStore } from "../entities/store.js";
import { SELF_ENTITY_ID } from "../entities/types.js";
import {
  createOwnerFactStore,
  type OwnerFactsPatch,
} from "../owner/fact-store.js";
import {
  applyExtractedEdges,
  type ExtractedEdge,
} from "../relationships/extraction.js";
import { RelationshipStore } from "../relationships/store.js";

type IdentityHint = {
  name: string;
  platform: string;
  handle: string;
};

type RelationshipHint = {
  name: string;
  type: string;
};

type ProfileExtraction = {
  facts: OwnerFactsPatch;
  identities: IdentityHint[];
  relationships: RelationshipHint[];
};

const FACT_PATTERNS = [
  {
    key: "preferredName",
    pattern:
      /\b(?:my name is|people call me|you can call me)\s+([^,.!?]{2,60})/iu,
  },
  {
    key: "preferredName",
    pattern: /\bcall me\s+(?!at\b|on\b)([^,.!?]{2,60})/iu,
  },
  {
    key: "location",
    pattern:
      /\b(?:i live in|i'm in|i am in|my location is)\s+([^,.!?]{2,80})/iu,
  },
  {
    key: "timezone",
    pattern: /\bmy timezone is\s+([A-Za-z0-9_/+.-]{2,60})/iu,
  },
  {
    key: "partnerName",
    pattern: /\bmy partner(?:'s name)? is\s+([^,.!?]{2,60})/iu,
  },
] as const;

const TRAVEL_PREFERENCE_CONTEXT =
  /\b(?:travel|booking|bookings|trip|trips|flight|flights|hotel|hotels)\b/iu;
const TRAVEL_PREFERENCE_DETAILS =
  /\b(?:aisle|window|seat|seats|checked\s+bag|checked\s+bags|carry-?on|luggage|hotel|hotels|budget|\$\d|venue|venues|mile|miles|night|nights)\b/iu;

const RELATIONSHIP_TYPES: Record<string, string> = {
  boss: "managed_by",
  manager: "managed_by",
  partner: "partner_of",
  spouse: "partner_of",
  colleague: "colleague_of",
  coworker: "colleague_of",
  teammate: "colleague_of",
  friend: "knows",
};

function messageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function cleanName(raw: string | undefined): string | null {
  const value = raw?.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
  if (!value || value.length < 2 || value.length > 80) return null;
  if (/^(?:me|my|mine|you|them|someone|somebody|at|on)$/iu.test(value)) {
    return null;
  }
  return value;
}

function cleanHandle(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/[),.;!?]+$/u, "");
  if (!value || value.length < 2 || value.length > 120) return null;
  return value;
}

function normalizePlatform(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "twitter") return "x";
  return normalized;
}

function collectFactHints(text: string, facts: OwnerFactsPatch): void {
  for (const entry of FACT_PATTERNS) {
    const match = entry.pattern.exec(text);
    const value = cleanName(match?.[1]);
    if (value) {
      facts[entry.key] = value;
    }
  }
}

function cleanTravelPreference(raw: string | undefined): string | null {
  const value = raw
    ?.replace(/\s+/g, " ")
    .replace(/^[\s:,-]+/u, "")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (!value || value.length < 8) {
    return null;
  }

  const withoutLeadIn = value
    .replace(/^(?:that\s+)?(?:i\s+)?prefer\s+/iu, "")
    .trim();
  if (!TRAVEL_PREFERENCE_DETAILS.test(withoutLeadIn)) {
    return null;
  }

  const normalized = withoutLeadIn.replace(/^(.)/u, (first) =>
    first.toUpperCase(),
  );
  return `Prefer ${normalized}`;
}

function collectTravelPreferenceHints(
  text: string,
  facts: OwnerFactsPatch,
): void {
  if (
    facts.travelBookingPreferences ||
    !/\bprefer(?:ence|ences|s|red)?\b/iu.test(text) ||
    !TRAVEL_PREFERENCE_CONTEXT.test(text)
  ) {
    return;
  }

  const patterns = [
    /\b(?:for\s+(?:all\s+)?future\s+travel\s+bookings?|for\s+travel\s+bookings?|when\s+booking\s+travel)[:,-]?\s*((?:i\s+)?prefer\s+[^.!?]{8,240})/iu,
    /\b(?:travel|booking|flight|hotel)\s+preferences?\s*(?:are|is|:|-)\s*([^.!?]{8,240})/iu,
    /\b(?:remember\s+that\s+)?((?:i\s+)?prefer\s+[^.!?]{8,240})/iu,
  ];

  for (const pattern of patterns) {
    const preference = cleanTravelPreference(pattern.exec(text)?.[1]);
    if (preference) {
      facts.travelBookingPreferences = preference;
      return;
    }
  }
}

function collectIdentityHints(text: string): IdentityHint[] {
  const hints: IdentityHint[] = [];
  const patterns = [
    /\b([A-Z][A-Za-z0-9 .'-]{1,60})'s\s+(telegram|slack|discord|twitter|x|email|github|nostr)\s+(?:handle|username|account|profile)\s+is\s+(@?[A-Za-z0-9_.+\-@]+)\b/gu,
    /\b(?:the\s+)?(telegram|slack|discord|twitter|x|email|github|nostr)\s+(?:handle|username|account|profile)\s+for\s+([A-Z][A-Za-z0-9 .'-]{1,60})\s+is\s+(@?[A-Za-z0-9_.+\-@]+)\b/gu,
    /\b([A-Z][A-Za-z0-9 .'-]{1,60})\s+(?:goes by|is)\s+(@[A-Za-z0-9_.+-]+)\s+on\s+(telegram|slack|discord|twitter|x|github|nostr)\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const first = match[1] ?? "";
      const second = match[2] ?? "";
      const third = match[3] ?? "";
      const platformFirst =
        /^(telegram|slack|discord|twitter|x|email|github|nostr)$/iu.test(first);
      const name = cleanName(platformFirst ? second : first);
      const platform = normalizePlatform(
        platformFirst ? first : third || second,
      );
      const handle = cleanHandle(platformFirst ? third : second);
      if (name && platform && handle) {
        hints.push({ name, platform, handle });
      }
    }
  }
  return hints;
}

function collectRelationshipHints(text: string): RelationshipHint[] {
  const hints: RelationshipHint[] = [];
  const pattern =
    /\b([A-Z][A-Za-z0-9 .'-]{1,60})\s+is\s+my\s+(boss|manager|partner|spouse|colleague|coworker|teammate|friend)\b/gu;
  for (const match of text.matchAll(pattern)) {
    const name = cleanName(match[1]);
    const role = (match[2] ?? "").toLowerCase();
    const type = RELATIONSHIP_TYPES[role];
    if (name && type) {
      hints.push({ name, type });
    }
  }
  return hints;
}

function extractProfileDetails(text: string): ProfileExtraction {
  const facts: OwnerFactsPatch = {};
  collectFactHints(text, facts);
  collectTravelPreferenceHints(text, facts);
  return {
    facts,
    identities: collectIdentityHints(text),
    relationships: collectRelationshipHints(text),
  };
}

function hasExtraction(extraction: ProfileExtraction): boolean {
  return (
    Object.keys(extraction.facts).length > 0 ||
    extraction.identities.length > 0 ||
    extraction.relationships.length > 0
  );
}

export const ownerProfileExtractionEvaluator: ResponseHandlerEvaluator = {
  name: "owner.profile_extraction",
  description:
    "Extracts stable owner facts, nicknames, handles, and relationship aliases before action planning.",
  priority: 30,
  async shouldRun({ runtime, message }) {
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    return hasExtraction(extractProfileDetails(messageText(message)));
  },
  async evaluate({
    runtime,
    message,
  }): Promise<ResponseHandlerPatch | undefined> {
    const text = messageText(message);
    const extraction = extractProfileDetails(text);
    if (!hasExtraction(extraction)) {
      return undefined;
    }

    const evidenceId = `message:${String(message.id ?? Date.now())}`;
    const recordedAt = new Date().toISOString();
    const debug: string[] = [];

    if (Object.keys(extraction.facts).length > 0) {
      await createOwnerFactStore(runtime).update(extraction.facts, {
        source: "agent_inferred",
        recordedAt,
        note: `response-handler extraction from ${evidenceId}`,
      });
      debug.push(`facts=${Object.keys(extraction.facts).length}`);
    }

    if (
      extraction.identities.length > 0 ||
      extraction.relationships.length > 0
    ) {
      const agentId = runtime.agentId;
      const entityStore = new EntityStore(runtime, agentId);
      const relationshipStore = new RelationshipStore(runtime, agentId);

      for (const identity of extraction.identities) {
        await entityStore.observeIdentity({
          platform: identity.platform,
          handle: identity.handle,
          displayName: identity.name,
          evidence: [evidenceId],
          confidence: 0.76,
          suggestedType: "person",
        });
      }
      if (extraction.identities.length > 0) {
        debug.push(`identities=${extraction.identities.length}`);
      }

      const edges: ExtractedEdge[] = extraction.relationships.map((hint) => ({
        fromRef: { id: SELF_ENTITY_ID },
        toRef: { name: hint.name, type: "person" },
        type: hint.type,
        confidence: 0.74,
      }));
      if (edges.length > 0) {
        await applyExtractedEdges({
          entityStore,
          relationshipStore,
          evidenceId,
          edges,
          source: "extraction",
        });
        debug.push(`relationships=${edges.length}`);
      }
    }

    return {
      debug,
      addContextSlices: [
        "Owner profile/entity details were extracted before planning.",
      ],
    };
  },
};
