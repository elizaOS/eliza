/**
 * Privacy filter for trajectory exports.
 *
 * Four jobs:
 *   1. Anonymize cross-platform handles by mapping them to opaque entity IDs
 *      (the caller supplies a lookup callback so app-training does not have
 *      to depend on the relationships service directly).
 *   2. Honor `ContactPreferences.privacyLevel` — drop entire trajectories if
 *      the participating entity is `private`.
 *   3. Strip credential references — env-var name patterns from process.env,
 *      plus the usual API key shapes (`sk-…`, `Bearer …`).
 *   4. Strip geo coordinates — bare decimal pairs, labeled `lat:`/`lng:`
 *      values, and JSON `"coords":{"latitude":..,"longitude":..}` blocks
 *      from the Location plugin — replaced with `[REDACTED_GEO]`.
 *
 * Run automatically before any export to disk; required for any cloud upload.
 */

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
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
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
 * Geo coordinate redaction.
 *
 * The travel-time consumer now reads from the Location plugin
 * (`apps/app-lifeops/src/travel-time/service.ts`), so precise lat/lon
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
  const { result, entityHits } = anonymizeHandles(credRedacted, options, state);
  for (const entityId of entityHits) collectedEntities.add(entityId);
  return result;
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
