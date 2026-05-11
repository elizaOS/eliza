/**
 * Privacy filter for trajectory exports.
 *
 * Jobs:
 *   1. Anonymize cross-platform handles by mapping them to opaque entity IDs
 *      (the caller supplies a lookup callback so app-training does not have
 *      to depend on the relationships service directly). `createHashAnonymizer`
 *      provides a stable, dependency-free default.
 *   2. Honor `ContactPreferences.privacyLevel` — drop entire trajectories if
 *      the participating entity is `private`.
 *   3. Strip credential references — env-var name patterns from process.env,
 *      plus the usual API key shapes (`sk-ant-…`, `sk-…`, `Bearer …`).
 *   4. Strip geo coordinates — bare decimal pairs, labeled `lat:`/`lng:`
 *      values, and JSON `"coords":{"latitude":..,"longitude":..}` blocks
 *      from the Location plugin — replaced with `[REDACTED_GEO]`.
 *   5. Strip PII — email addresses (`[REDACTED_EMAIL]`), phone numbers
 *      (`[REDACTED_PHONE]`), and street/PO-box/city-state-ZIP addresses
 *      (`[REDACTED_ADDRESS]`).
 *
 * Walks every string in `steps[].llmCalls[].{systemPrompt,userPrompt,response}`,
 * `steps[].providerAccesses[].data`, and the top-level `metadata` object.
 *
 * Run automatically before any export to disk; required for any cloud upload.
 */

import { createHash } from "node:crypto";

export type PrivacyLevel = "public" | "limited" | "private";

export interface AnonymizerLookup {
  /** Look up the opaque entity ID for a (platform, handle) pair. */
  resolveEntityId(platform: string, handle: string): string | null;
  /** Look up the privacy level for an entity. Defaults to "public". */
  getPrivacyLevel?(entityId: string): PrivacyLevel | undefined;
}

export interface PrivacyFilterOptions {
  /** Optional anonymizer lookup. If absent, handles pass through unchanged. */
  anonymizer?: AnonymizerLookup;
  /**
   * Additional credential shapes to redact. Each entry is matched as a
   * RegExp against any string field; matches are replaced with
   * `<REDACTED:{label}>`.
   */
  extraCredentialPatterns?: Array<{ label: string; pattern: RegExp }>;
  /**
   * Snapshot of `process.env` keys to treat as credential names.
   * Defaults to capturing all env names matching the standard secret regex.
   */
  envKeySnapshot?: string[];
  /**
   * Hard list of platforms the anonymizer recognizes. Used to constrain
   * cross-platform handle detection. Defaults to common platforms.
   */
  platforms?: string[];
}

export interface FilterableTrajectory {
  trajectoryId?: string;
  steps?: Array<{
    llmCalls?: Array<{
      systemPrompt?: string;
      userPrompt?: string;
      response?: string;
    }>;
    providerAccesses?: Array<{
      data?: unknown;
    }>;
  }>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FilterResult<T> {
  trajectories: T[];
  dropped: Array<{ trajectoryId?: string; reason: string }>;
  redactionCount: number;
  anonymizationCount: number;
}

const DEFAULT_PLATFORMS = [
  "telegram",
  "discord",
  "slack",
  "matrix",
  "signal",
  "whatsapp",
  "twitter",
  "instagram",
  "email",
];

const HANDLE_PATTERN = /(@[a-zA-Z0-9_.-]{2,})/g;

const DEFAULT_CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // `sk-ant-…` must be matched before the generic `sk-…` so the more specific
  // Anthropic label wins.
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  {
    label: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g,
  },
  {
    label: "github-token",
    pattern: /\bghp_[A-Za-z0-9]{20,}\b/g,
  },
  {
    label: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
];

/**
 * PII redaction (email / phone / address). Applied in the order
 * email → address → phone so phone-like number runs inside an address tail
 * (e.g. ZIP codes) are consumed by the address pass first, and bare digit
 * runs without separators survive.
 */
const EMAIL_REPLACEMENT = "[REDACTED_EMAIL]";
const PHONE_REPLACEMENT = "[REDACTED_PHONE]";
const ADDRESS_REPLACEMENT = "[REDACTED_ADDRESS]";

const EMAIL_PATTERN =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const STREET_SUFFIXES =
  "St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Ln|Lane|Dr|Drive|Ct|Court|Pl|Place|Way|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square|Trl|Trail|Loop";
const UNIT_DESIGNATORS =
  "Apt|Apartment|Suite|Ste|Unit|Bldg|Building|Fl|Floor|Rm|Room|#";
const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

const DEFAULT_ADDRESS_PATTERNS: RegExp[] = [
  // 1. Numbered street + suffix + optional unit, optionally followed by a
  //    city, state, ZIP tail: `1600 Amphitheatre Parkway, Suite 200,
  //    Mountain View, CA 94043`.
  new RegExp(
    String.raw`\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:${STREET_SUFFIXES})\b` +
      String.raw`(?:\s*,?\s*(?:${UNIT_DESIGNATORS})\.?\s*[A-Za-z0-9-]+)?` +
      String.raw`(?:\s*,\s*[A-Za-z .'-]+,?\s*(?:${US_STATES})\s+\d{5}(?:-\d{4})?)?`,
    "gi",
  ),
  // 2. `PO Box 4242` / `P.O. Box 4242`.
  /\bP\.?\s?O\.?\s?Box\s+\d{1,7}\b/gi,
  // 3. Standalone city, state, ZIP tail: `Mountain View, CA 94043`.
  new RegExp(
    String.raw`\b[A-Za-z .'-]+,\s*(?:${US_STATES})\s+\d{5}(?:-\d{4})?\b`,
    "g",
  ),
];

const DEFAULT_PHONE_PATTERNS: RegExp[] = [
  // 1. E.164 / international with leading `+`: `+44 20 7946 0958`,
  //    `+1-415-555-0123`, `+442079460958`.
  /\+\d{1,3}(?:[\s.-]?\d{1,4}){1,5}\b/g,
  // 2. NANP with explicit separators (a separator is REQUIRED between groups
  //    so bare 10-digit runs survive): `(415) 555-0123`, `415-555-0123`,
  //    `415.555.0123`, `415 555 0123`. No leading `\b` before `(` — there is
  //    no word boundary between a space and `(`.
  /(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g,
];

/**
 * Geo coordinate redaction.
 *
 * The travel-time consumer now reads from the Location plugin
 * (`plugins/app-lifeops/src/travel-time/service.ts`), so precise lat/lon
 * values can land in trajectory text. We strip them before any export with
 * the marker `[REDACTED_GEO]`.
 *
 * Patterns are intentionally narrow — they require a lat/lng label, a JSON
 * wrapper, or at least one decimal place per number — so we do not redact
 * ordinary integer pairs (timestamps, IDs) that happen to be comma-separated.
 *
 * Order matters: the JSON `coords` block is consumed first so the inner
 * `latitude/longitude` pair does not get redacted twice.
 */
const GEO_REPLACEMENT = "[REDACTED_GEO]";

const DEFAULT_GEO_PATTERNS: RegExp[] = [
  // 1. JSON `"coords":{"latitude":..,"longitude":..[,...]}` (Capacitor shape).
  /"coords"\s*:\s*\{\s*"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?(?:\s*,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*[^,}]+)*\s*\}/g,
  // 2. Bare JSON pair `"latitude":..,"longitude":..`.
  /"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?/g,
  // 3. `current location: 37.7, -122.4` / `coords: ...` / `coordinates=...`.
  /\b(?:current\s+location|location|coords|coordinates)\s*[:=]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/gi,
  // 4. Labeled `lat: .., lng: ..` / `latitude=.., longitude=..`.
  /\b(?:lat|latitude)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,;]\s*(?:lng|lon|long|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
  // 5. Bare decimal pair `37.7749, -122.4194` (both numbers must have a
  //    fractional component to avoid matching integer pairs).
  /\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b/g,
];

function snapshotEnvCredentials(envKeys: string[]): string[] {
  // Heuristic: a key counts as a credential if its NAME matches a common
  // secret-marker substring AND its VALUE is non-empty and reasonably long.
  const interesting = /KEY|TOKEN|SECRET|PASSWORD|API|CREDENTIAL/i;
  const out: string[] = [];
  for (const key of envKeys) {
    if (!interesting.test(key)) continue;
    const value = process.env[key];
    if (typeof value !== "string") continue;
    if (value.length < 8) continue;
    out.push(value);
  }
  return out;
}

interface InternalState {
  anonymizationCount: number;
  redactionCount: number;
}

function redactCredentials(
  value: string,
  patterns: Array<{ label: string; pattern: RegExp }>,
  credentialValues: string[],
  state: InternalState,
): string {
  let out = value;
  for (const { label, pattern } of patterns) {
    out = out.replace(pattern, () => {
      state.redactionCount += 1;
      return `<REDACTED:${label}>`;
    });
  }
  for (const credValue of credentialValues) {
    if (!credValue) continue;
    const escaped = credValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    out = out.replace(re, () => {
      state.redactionCount += 1;
      return "<REDACTED:env-secret>";
    });
  }
  return out;
}

function redactGeo(value: string, state: InternalState): string {
  let out = value;
  for (const pattern of DEFAULT_GEO_PATTERNS) {
    out = out.replace(pattern, () => {
      state.redactionCount += 1;
      return GEO_REPLACEMENT;
    });
  }
  return out;
}

function redactPii(value: string, state: InternalState): string {
  let out = value;
  // email → address → phone (see note on DEFAULT_PHONE_PATTERNS / addresses).
  out = out.replace(EMAIL_PATTERN, () => {
    state.redactionCount += 1;
    return EMAIL_REPLACEMENT;
  });
  for (const pattern of DEFAULT_ADDRESS_PATTERNS) {
    out = out.replace(pattern, () => {
      state.redactionCount += 1;
      return ADDRESS_REPLACEMENT;
    });
  }
  for (const pattern of DEFAULT_PHONE_PATTERNS) {
    out = out.replace(pattern, () => {
      state.redactionCount += 1;
      return PHONE_REPLACEMENT;
    });
  }
  return out;
}

function anonymizeHandles(
  value: string,
  options: PrivacyFilterOptions,
  state: InternalState,
): { result: string; entityHits: Set<string> } {
  const platforms = options.platforms ?? DEFAULT_PLATFORMS;
  const entityHits = new Set<string>();
  if (!options.anonymizer) {
    return { result: value, entityHits };
  }

  const result = value.replace(HANDLE_PATTERN, (match, handle: string) => {
    const stripped = handle.startsWith("@") ? handle.slice(1) : handle;
    for (const platform of platforms) {
      const entityId = options.anonymizer?.resolveEntityId(platform, stripped);
      if (entityId) {
        state.anonymizationCount += 1;
        entityHits.add(entityId);
        return `<entity:${entityId}>`;
      }
    }
    return match;
  });
  return { result, entityHits };
}

function transformText(
  value: string,
  options: PrivacyFilterOptions,
  credentialValues: string[],
  credentialPatterns: Array<{ label: string; pattern: RegExp }>,
  state: InternalState,
  collectedEntities: Set<string>,
): string {
  // Geo first so JSON `coords` blocks collapse before any later pass can see
  // a stray decimal pair inside them.
  const geoRedacted = redactGeo(value, state);
  const credRedacted = redactCredentials(
    geoRedacted,
    credentialPatterns,
    credentialValues,
    state,
  );
  const piiRedacted = redactPii(credRedacted, state);
  const { result, entityHits } = anonymizeHandles(piiRedacted, options, state);
  for (const entityId of entityHits) collectedEntities.add(entityId);
  return result;
}

/**
 * Recursively transform every string contained in `value` (objects, arrays,
 * and nested combinations). Returns the same shape with strings rewritten.
 */
function transformDeep(
  value: unknown,
  options: PrivacyFilterOptions,
  credentialValues: string[],
  credentialPatterns: Array<{ label: string; pattern: RegExp }>,
  state: InternalState,
  collectedEntities: Set<string>,
): unknown {
  if (typeof value === "string") {
    return transformText(
      value,
      options,
      credentialValues,
      credentialPatterns,
      state,
      collectedEntities,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      transformDeep(
        entry,
        options,
        credentialValues,
        credentialPatterns,
        state,
        collectedEntities,
      ),
    );
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = transformDeep(
        entry,
        options,
        credentialValues,
        credentialPatterns,
        state,
        collectedEntities,
      );
    }
    return out;
  }
  return value;
}

/**
 * Apply the privacy filter to a list of trajectories. Returns the filtered
 * list with credential references redacted and platform handles replaced by
 * opaque entity IDs. Trajectories whose anonymized entities are marked as
 * `private` are dropped wholesale.
 */
export function applyPrivacyFilter<T extends FilterableTrajectory>(
  trajectories: T[],
  options: PrivacyFilterOptions = {},
): FilterResult<T> {
  const credentialPatterns = [
    ...DEFAULT_CREDENTIAL_PATTERNS,
    ...(options.extraCredentialPatterns ?? []),
  ];
  const envKeys = options.envKeySnapshot ?? Object.keys(process.env);
  const credentialValues = snapshotEnvCredentials(envKeys);

  const dropped: Array<{ trajectoryId?: string; reason: string }> = [];
  const filtered: T[] = [];
  const state: InternalState = {
    anonymizationCount: 0,
    redactionCount: 0,
  };

  for (const trajectory of trajectories) {
    const trajectoryEntities = new Set<string>();
    const cloned = JSON.parse(JSON.stringify(trajectory)) as T;
    const steps = cloned.steps ?? [];
    for (const step of steps) {
      for (const call of step.llmCalls ?? []) {
        if (typeof call.systemPrompt === "string") {
          call.systemPrompt = transformText(
            call.systemPrompt,
            options,
            credentialValues,
            credentialPatterns,
            state,
            trajectoryEntities,
          );
        }
        if (typeof call.userPrompt === "string") {
          call.userPrompt = transformText(
            call.userPrompt,
            options,
            credentialValues,
            credentialPatterns,
            state,
            trajectoryEntities,
          );
        }
        if (typeof call.response === "string") {
          call.response = transformText(
            call.response,
            options,
            credentialValues,
            credentialPatterns,
            state,
            trajectoryEntities,
          );
        }
      }
      for (const access of step.providerAccesses ?? []) {
        if (access.data !== undefined) {
          access.data = transformDeep(
            access.data,
            options,
            credentialValues,
            credentialPatterns,
            state,
            trajectoryEntities,
          );
        }
      }
    }

    if (cloned.metadata && typeof cloned.metadata === "object") {
      cloned.metadata = transformDeep(
        cloned.metadata,
        options,
        credentialValues,
        credentialPatterns,
        state,
        trajectoryEntities,
      ) as Record<string, unknown>;
    }

    // Drop the whole trajectory if any participating entity is private.
    const lookup = options.anonymizer?.getPrivacyLevel;
    if (lookup) {
      let isPrivate = false;
      for (const entityId of trajectoryEntities) {
        if (lookup(entityId) === "private") {
          isPrivate = true;
          break;
        }
      }
      if (isPrivate) {
        dropped.push({
          trajectoryId: trajectory.trajectoryId,
          reason: "entity-private",
        });
        continue;
      }
    }

    filtered.push(cloned);
  }

  return {
    trajectories: filtered,
    dropped,
    redactionCount: state.redactionCount,
    anonymizationCount: state.anonymizationCount,
  };
}

/**
 * Stable, dependency-free anonymizer: maps a `(platform, handle)` pair to a
 * 16-hex-character opaque id via `SHA-256(salt:platform:handle)`. The same
 * handle always resolves to the same id (for a given salt), so cross-message
 * references stay linkable in the exported corpus while the real handle is
 * gone. Returns the id for every handle (never `null`), so all `@mentions`
 * get anonymized.
 */
export function createHashAnonymizer(salt = ""): AnonymizerLookup {
  return {
    resolveEntityId(platform: string, handle: string): string {
      return createHash("sha256")
        .update(`${salt}:${platform.toLowerCase()}:${handle.toLowerCase()}`)
        .digest("hex")
        .slice(0, 16);
    },
  };
}
