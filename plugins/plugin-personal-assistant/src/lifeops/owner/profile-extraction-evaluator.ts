/**
 * Response-handler evaluator that extracts durable owner facts and relationship
 * edges from the incoming owner message before planning, then persists them to
 * the owner-fact store and relationship graph. Registered as the
 * `owner.profile_extraction` evaluator.
 */
import { hasOwnerAccess, resolveKnowledgeGraphService } from "@elizaos/agent";
import type {
  ResponseHandlerEvaluator,
  ResponseHandlerPatch,
} from "@elizaos/core";
import { isValidTimeZone } from "../defaults.js";
import { SELF_ENTITY_ID } from "../entities/types.js";
import {
  createOwnerFactStore,
  type OwnerFactsPatch,
} from "../owner/fact-store.js";
import {
  cleanHandle,
  cleanName,
  normalizePlatform,
  relationTypeForRole,
} from "../owner/profile-hints.js";
import {
  applyExtractedEdges,
  type ExtractedEdge,
} from "../relationships/extraction.js";

/**
 * Upper bound on a declared travel window with no parsed return date. A person
 * saying "I'm traveling" without an end date is away for a trip, not relocating
 * permanently — so we cap the derived `travelActive` window rather than leave it
 * open-ended, which would let a one-off statement silence scheduled tasks
 * forever. 30 days comfortably covers any normal trip; the reconciler and any
 * later "I'm back" clear it sooner.
 */
const MAX_TRAVEL_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

type IdentityHint = {
  name: string;
  platform: string;
  handle: string;
};

type RelationshipHint = {
  name: string;
  type: string;
};

/**
 * A detected travel-state transition. `set` opens a window (with an optional
 * parsed return date); `clear` closes it. Absent when the text carries no
 * travel signal — distinct from a signal that yields no state change.
 */
type TravelSignal = { kind: "set"; endIso?: string } | { kind: "clear" };

type ProfileExtraction = {
  facts: OwnerFactsPatch;
  identities: IdentityHint[];
  relationships: RelationshipHint[];
  travel: TravelSignal | null;
};

const NAME_PATTERNS = [
  /\b(?:my name is|my name's|people call me|you can call me|i go by)\s+([^,.!?;\n]{2,60})/iu,
  /\b(?:please\s+)?call me\s+(?!at\b|on\b)([^,.!?;\n]{2,60})/iu,
] as const;

/**
 * Only durable home/base declarations qualify. A bare "I'm in X" is a
 * transient check-in and must never overwrite the owner's home location.
 */
const HOME_LOCATION_PATTERNS = [
  /\b(?:i live in|i am based in|i'm based in)\s+([^,.!?;\n]{2,80})/iu,
  /\bmy (?:home|home base) is (?:in\s+)?([^,.!?;\n]{2,80})/iu,
  /\bi moved to\s+([^,.!?;\n]{2,80})/iu,
] as const;

const TIMEZONE_PATTERNS = [
  /\bmy time\s*zone is\s+([A-Za-z0-9_/+.:-]{2,60})/iu,
  /\b(?:use|set)\s+([A-Za-z0-9_/+.:-]{2,60})\s+as my time\s*zone\b/iu,
  /\b(?:use|set)\s+my time\s*zone to\s+([A-Za-z0-9_/+.:-]{2,60})/iu,
] as const;

const OTHER_FACT_PATTERNS = [
  {
    key: "partnerName",
    pattern: /\bmy partner(?:'s name)? is\s+([^,.!?]{2,60})/iu,
  },
] as const;

const UTC_TIMEZONE_PATTERN =
  /^(?:z|zulu|utc|gmt|etc\/utc|etc\/gmt|utc[+-]0{1,2}(?::?00)?|gmt[+-]0{1,2}(?::?00)?|[+-]00:?00)$/iu;

const TRAVEL_PREFERENCE_CONTEXT =
  /\b(?:travel|booking|bookings|trip|trips|flight|flights|hotel|hotels)\b/iu;
const TRAVEL_PREFERENCE_DETAILS =
  /\b(?:aisle|window|seat|seats|checked\s+bag|checked\s+bags|carry-?on|luggage|hotel|hotels|budget|\$\d|venue|venues|mile|miles|night|nights)\b/iu;

function messageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function cleanExplicitValue(raw: string | undefined): string | null {
  return cleanName(
    raw
      ?.replace(/\s+(?:and|but)\s+i\b.*$/iu, "")
      .replace(/\s+from now on$/iu, "")
      .replace(/\s+please$/iu, ""),
  );
}

function cleanExplicitTimeZone(raw: string | undefined): string | null {
  const candidate = raw?.trim().replace(/[),.;!?]+$/u, "") ?? "";
  if (!candidate) return null;
  if (UTC_TIMEZONE_PATTERN.test(candidate)) return "UTC";
  // ICU accepts several short abbreviations even though they are ambiguous
  // across regions. Persist only explicit IANA identifiers here.
  if (!candidate.includes("/")) return null;
  return isValidTimeZone(candidate) ? candidate : null;
}

function firstExplicitValue(
  text: string,
  patterns: readonly RegExp[],
): string | null {
  for (const pattern of patterns) {
    const value = cleanExplicitValue(pattern.exec(text)?.[1]);
    if (value) return value;
  }
  return null;
}

function collectFactHints(text: string, facts: OwnerFactsPatch): void {
  for (const pattern of NAME_PATTERNS) {
    const value = cleanExplicitValue(pattern.exec(text)?.[1]);
    if (value) {
      // A later, more specific "call me" clause should override a legal name.
      facts.preferredName = value;
    }
  }

  const location = firstExplicitValue(text, HOME_LOCATION_PATTERNS);
  if (location) facts.location = location;

  for (const pattern of TIMEZONE_PATTERNS) {
    const timezone = cleanExplicitTimeZone(pattern.exec(text)?.[1]);
    if (timezone) {
      facts.timezone = timezone;
      break;
    }
  }

  for (const entry of OTHER_FACT_PATTERNS) {
    const match = entry.pattern.exec(text);
    const value = cleanExplicitValue(match?.[1]);
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
    const type = relationTypeForRole(role);
    if (name && type) {
      hints.push({ name, type });
    }
  }
  return hints;
}

// "I'm back" / "back home" / "home now" — the owner has returned. Checked
// first so "I'm back home" clears rather than being read as a trip statement.
const TRAVEL_CLEAR_PATTERN =
  /\b(?:i'?m\s+back|i\s+am\s+back|back\s+home|(?:i'?m|i\s+am)\s+home\s+now|got\s+(?:back|home)|(?:i'?m|i\s+am)\s+(?:back\s+)?in\s+(?:town|the\s+office))\b/iu;

// "I'm traveling / away / on a trip / out of town", optionally "until <date>".
const TRAVEL_SET_PATTERN =
  /\b(?:i'?m|i\s+am)\s+(?:traveling|travelling|away|on\s+(?:a\s+)?(?:trip|vacation|holiday)|out\s+of\s+(?:town|(?:the\s+)?office))\b/iu;

// Captures the return-date phrase after "until"/"till"/"through"/"back on".
const TRAVEL_UNTIL_PATTERN =
  /\b(?:until|till|til|through|thru|back\s+(?:on|by))\s+([A-Za-z0-9 ,/.'-]{3,40})/iu;

/**
 * Parses a free-text return-date phrase to a bounded ISO end. Returns null when
 * it cannot resolve a real future date within `MAX_TRAVEL_HORIZON_MS`; the
 * caller then falls back to the horizon cap. `Date.parse` handles common forms
 * ("July 20", "2026-07-20", "Aug 3"); the current year is assumed when the
 * parsed date lands in the past (a bare month/day for a future trip).
 */
const HAS_EXPLICIT_YEAR = /\b\d{4}\b/;
const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `Date.parse` reads a bare `YYYY-MM-DD` string as UTC midnight but a
 * `Month Day[, Year]` string as LOCAL midnight (ECMA-262 Date Time String
 * Format) -- read the ISO date-only form as a local calendar date too, so
 * "back on 2026-07-20" and "back on July 20, 2026" always land on the same
 * day regardless of the caller's UTC offset. Never NaN; unparseable => null.
 */
function parseLocalDate(value: string): number | null {
  const isoMatch = ISO_DATE_ONLY.exec(value);
  if (isoMatch) {
    const [, yearStr, monthStr, dayStr] = isoMatch;
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    // `new Date(y, m, d)` silently rolls an impossible calendar date into a
    // real one (Feb 29 on a non-leap year, month 13, day 0) instead of
    // rejecting it -- round-trip the constructed date's local fields against
    // the parsed input and reject on any mismatch. This also rejects a
    // 4-digit-but-under-100 year like "0099", which the Date constructor's
    // legacy two-digit-year rule (0-99 -> 1900-1999) would otherwise remap.
    const local = new Date(year, month - 1, day);
    if (
      Number.isNaN(local.getTime()) ||
      local.getFullYear() !== year ||
      local.getMonth() !== month - 1 ||
      local.getDate() !== day
    ) {
      return null;
    }
    return local.getTime();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseTravelReturnIso(phrase: string, now: Date): string | null {
  const trimmed = phrase.trim().replace(/[.,]+$/u, "");
  if (trimmed.length === 0) return null;

  // A bare "Month Day" string never fails to parse: absent a year,
  // `Date.parse` silently substitutes a fixed placeholder year instead of
  // returning NaN, so detecting "no year given" from the parse result never
  // fires. Detect it from the text instead and only then append the current
  // year, so a date still upcoming this year isn't skipped straight to next
  // year -- which usually lands outside MAX_TRAVEL_HORIZON_MS and silently
  // discards the user's stated return date entirely.
  const candidate = HAS_EXPLICIT_YEAR.test(trimmed)
    ? trimmed
    : `${trimmed} ${now.getFullYear()}`;
  let parsed = parseLocalDate(candidate);
  if (parsed === null) return null;
  // A month/day that resolves to the past almost always means next year.
  if (parsed < now.getTime()) {
    const nextYear = parseLocalDate(`${trimmed} ${now.getFullYear() + 1}`);
    if (nextYear === null || nextYear < now.getTime()) return null;
    parsed = nextYear;
  }
  if (parsed - now.getTime() > MAX_TRAVEL_HORIZON_MS) return null;
  return new Date(parsed).toISOString();
}

function detectTravelSignal(text: string, now: Date): TravelSignal | null {
  if (TRAVEL_CLEAR_PATTERN.test(text)) {
    return { kind: "clear" };
  }
  if (TRAVEL_SET_PATTERN.test(text)) {
    const until = TRAVEL_UNTIL_PATTERN.exec(text)?.[1];
    const endIso = until ? parseTravelReturnIso(until, now) : null;
    return endIso ? { kind: "set", endIso } : { kind: "set" };
  }
  return null;
}

export function extractProfileDetails(
  text: string,
  now: Date,
): ProfileExtraction {
  const facts: OwnerFactsPatch = {};
  collectFactHints(text, facts);
  collectTravelPreferenceHints(text, facts);
  return {
    facts,
    identities: collectIdentityHints(text),
    relationships: collectRelationshipHints(text),
    travel: detectTravelSignal(text, now),
  };
}

function hasExtraction(extraction: ProfileExtraction): boolean {
  return (
    Object.keys(extraction.facts).length > 0 ||
    extraction.identities.length > 0 ||
    extraction.relationships.length > 0 ||
    extraction.travel !== null
  );
}

export const ownerProfileExtractionEvaluator: ResponseHandlerEvaluator = {
  name: "owner.profile_extraction",
  description:
    "Extract stable owner facts, nicknames, handles, relationship aliases before planning.",
  priority: 30,
  async shouldRun({ runtime, message }) {
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    return hasExtraction(
      extractProfileDetails(messageText(message), new Date()),
    );
  },
  async evaluate({
    runtime,
    message,
  }): Promise<ResponseHandlerPatch | undefined> {
    const text = messageText(message);
    const now = new Date();
    const extraction = extractProfileDetails(text, now);
    if (!hasExtraction(extraction)) {
      return undefined;
    }

    const evidenceId = `message:${String(message.id ?? Date.now())}`;
    const recordedAt = now.toISOString();
    const debug: string[] = [];

    if (Object.keys(extraction.facts).length > 0) {
      await createOwnerFactStore(runtime).update(extraction.facts, {
        source: "owner_explicit",
        recordedAt,
        confidence: 0.98,
        note: `response-handler extraction from ${evidenceId}`,
      });
      debug.push(`facts=${Object.keys(extraction.facts).length}`);
    }

    if (extraction.travel !== null) {
      const store = createOwnerFactStore(runtime);
      const provenance = {
        source: "owner_explicit" as const,
        recordedAt,
        confidence: 0.98,
        note: `travel-state extraction from ${evidenceId}`,
      };
      if (extraction.travel.kind === "clear") {
        await store.setActiveTravel(null, provenance);
        debug.push("travel=clear");
      } else {
        // Bound every declared window: a parsed return date when present, else
        // the horizon cap. Never open-ended — see MAX_TRAVEL_HORIZON_MS.
        const endIso =
          extraction.travel.endIso ??
          new Date(now.getTime() + MAX_TRAVEL_HORIZON_MS).toISOString();
        await store.setActiveTravel(
          { startIso: recordedAt, endIso },
          provenance,
        );
        debug.push("travel=set");
      }
    }

    if (
      extraction.identities.length > 0 ||
      extraction.relationships.length > 0
    ) {
      const agentId = runtime.agentId;
      const knowledgeGraph = resolveKnowledgeGraphService(runtime);
      if (!knowledgeGraph) {
        throw new Error(
          "[owner.profile_extraction] KnowledgeGraphService is not registered on the runtime",
        );
      }
      const entityStore = knowledgeGraph.getEntityStore(agentId);
      const relationshipStore = knowledgeGraph.getRelationshipStore(agentId);

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
