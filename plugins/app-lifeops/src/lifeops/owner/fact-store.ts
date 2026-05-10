/**
 * `OwnerFactStore` — single typed store for owner facts, preferences, and
 * policies, distinguishing facts (durable owner state) from policies
 * (preferences that gate behavior).
 *
 * The store holds `LifeOpsOwnerProfile` plus the facts
 * (`travelBookingPreferences`, `quietHours`, `morningWindow`,
 * `eveningWindow`, `preferredNotificationChannel`, `locale`). Each entry
 * carries a provenance record so call sites can distinguish a value the user
 * typed in first-run customize from one the agent inferred from a connector
 * — and so audits can trace the origin.
 *
 * `set_reminder_preference` and `configure_escalation` (previously routed
 * through `PROFILE`) write into the store's policy entries.
 *
 * Persistence: cache-backed, single record per agent. The cache key is
 * `eliza:lifeops:owner-fact-store:v1`. The legacy `LifeOpsOwnerProfile`
 * task-metadata payload remains read-only for back-compat readers
 * (`readLifeOpsOwnerProfile` / `service-mixin-calendar.ts`) — this store
 * is the canonical writer.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type LifeOpsOwnerProfilePatch,
  persistConfiguredOwnerName,
  updateLifeOpsOwnerProfile,
} from "../owner-profile.js";
import { asCacheRuntime } from "../runtime-cache.js";

// --- Types ----------------------------------------------------------------

export interface OwnerFactWindow {
  /** "HH:MM" 24h. Local to `timezone`. */
  startLocal: string;
  /** "HH:MM" 24h. Local to `timezone`. */
  endLocal: string;
}

export interface OwnerQuietHours {
  /** "HH:MM" 24h. Local to `timezone`. */
  startLocal: string;
  /** "HH:MM" 24h. Local to `timezone`. */
  endLocal: string;
  /** IANA timezone the start/end values are interpreted in. */
  timezone: string;
}

/**
 * Source of truth for a stored fact. `first_run` distinguishes answers
 * captured by the first-run capability from answers captured by the
 * planner via `PROFILE.save`. `connector_inferred` covers values an
 * adapter wrote (e.g. timezone from Google Calendar). `agent_inferred`
 * covers LLM-derived values (e.g. relationshipStatus extracted from a
 * conversation).
 */
export type OwnerFactProvenanceSource =
  | "first_run"
  | "profile_save"
  | "connector_inferred"
  | "agent_inferred"
  | "policy_action";

export interface OwnerFactProvenance {
  source: OwnerFactProvenanceSource;
  /** ISO-8601 timestamp of the write that produced this value. */
  recordedAt: string;
  /** Optional free-form note explaining the write (audit trail). */
  note?: string;
}

export interface OwnerFactEntry<T> {
  value: T;
  provenance: OwnerFactProvenance;
}

export type ReminderIntensity =
  | "minimal"
  | "normal"
  | "persistent"
  | "high_priority_only";

export interface EscalationRule {
  /** Optional definition id this rule scopes to; null = global default. */
  definitionId: string | null;
  /** Minutes after fire before escalating. */
  timeoutMinutes: number | null;
  /** Minutes after fire before escalating to a voice call. */
  callAfterMinutes: number | null;
}

/**
 * Canonical fact set. Typed entries with provenance. Adding a fact means
 * adding the field here and (where needed) adding a normalizer to
 * `normalizePatch`.
 */
export interface OwnerFacts {
  // Identity
  preferredName?: OwnerFactEntry<string>;
  relationshipStatus?: OwnerFactEntry<string>;
  partnerName?: OwnerFactEntry<string>;
  orientation?: OwnerFactEntry<string>;
  gender?: OwnerFactEntry<string>;
  age?: OwnerFactEntry<string>;
  location?: OwnerFactEntry<string>;

  // Preferences
  travelBookingPreferences?: OwnerFactEntry<string>;
  morningWindow?: OwnerFactEntry<OwnerFactWindow>;
  eveningWindow?: OwnerFactEntry<OwnerFactWindow>;
  quietHours?: OwnerFactEntry<OwnerQuietHours>;
  preferredNotificationChannel?: OwnerFactEntry<string>;
  locale?: OwnerFactEntry<string>;
  timezone?: OwnerFactEntry<string>;

  // Policies (writable via the policy-aware setters; read-only here)
  reminderIntensity?: OwnerFactEntry<ReminderIntensity>;
  escalationRules?: OwnerFactEntry<EscalationRule[]>;
}

export interface OwnerFactsPatch {
  preferredName?: string;
  relationshipStatus?: string;
  partnerName?: string;
  orientation?: string;
  gender?: string;
  age?: string;
  location?: string;
  travelBookingPreferences?: string;
  morningWindow?: OwnerFactWindow;
  eveningWindow?: OwnerFactWindow;
  quietHours?: OwnerQuietHours;
  preferredNotificationChannel?: string;
  locale?: string;
  timezone?: string;
}

export interface PolicyPatchReminderIntensity {
  intensity: ReminderIntensity;
  /** Optional note to include in provenance. */
  note?: string;
}

export interface PolicyPatchEscalationRule {
  rule: EscalationRule;
  /** Optional note to include in provenance. */
  note?: string;
}

export interface OwnerFactStore {
  read(): Promise<OwnerFacts>;
  /** Write fact entries. Provenance is recorded for every patched key. */
  update(
    patch: OwnerFactsPatch,
    provenance: OwnerFactProvenance,
  ): Promise<OwnerFacts>;
  /** Set the reminder-intensity policy. */
  setReminderIntensity(
    patch: PolicyPatchReminderIntensity,
    provenance: OwnerFactProvenance,
  ): Promise<OwnerFacts>;
  /**
   * Upsert an escalation rule. Rules are matched by `definitionId`
   * (`null` = global). Calling with an existing key replaces it.
   */
  upsertEscalationRule(
    patch: PolicyPatchEscalationRule,
    provenance: OwnerFactProvenance,
  ): Promise<OwnerFacts>;
}

// --- Persistence ----------------------------------------------------------

const FACT_STORE_CACHE_KEY = "eliza:lifeops:owner-fact-store:v1";

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface PersistedRecord {
  schemaVersion: 1;
  facts: OwnerFacts;
}

function emptyRecord(): PersistedRecord {
  return { schemaVersion: 1, facts: {} };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWindow(value: unknown): value is OwnerFactWindow {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.startLocal === "string" &&
    TIME_OF_DAY_PATTERN.test(value.startLocal) &&
    typeof value.endLocal === "string" &&
    TIME_OF_DAY_PATTERN.test(value.endLocal)
  );
}

function isQuietHours(value: unknown): value is OwnerQuietHours {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.startLocal === "string" &&
    TIME_OF_DAY_PATTERN.test(value.startLocal) &&
    typeof value.endLocal === "string" &&
    TIME_OF_DAY_PATTERN.test(value.endLocal) &&
    typeof value.timezone === "string" &&
    value.timezone.length > 0
  );
}

function isReminderIntensity(value: unknown): value is ReminderIntensity {
  return (
    value === "minimal" ||
    value === "normal" ||
    value === "persistent" ||
    value === "high_priority_only"
  );
}

function isProvenanceSource(
  value: unknown,
): value is OwnerFactProvenanceSource {
  return (
    value === "first_run" ||
    value === "profile_save" ||
    value === "connector_inferred" ||
    value === "agent_inferred" ||
    value === "policy_action"
  );
}

function normalizeProvenance(value: unknown): OwnerFactProvenance | null {
  if (!isPlainRecord(value)) return null;
  if (!isProvenanceSource(value.source)) return null;
  if (typeof value.recordedAt !== "string" || value.recordedAt.length === 0) {
    return null;
  }
  const provenance: OwnerFactProvenance = {
    source: value.source,
    recordedAt: value.recordedAt,
  };
  if (typeof value.note === "string" && value.note.length > 0) {
    provenance.note = value.note;
  }
  return provenance;
}

function normalizeStringEntry(
  value: unknown,
): OwnerFactEntry<string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const stringValue = typeof value.value === "string" ? value.value.trim() : "";
  if (!stringValue) return undefined;
  const provenance = normalizeProvenance(value.provenance);
  if (!provenance) return undefined;
  return { value: stringValue, provenance };
}

function normalizeWindowEntry(
  value: unknown,
): OwnerFactEntry<OwnerFactWindow> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const window = isWindow(value.value) ? value.value : null;
  if (!window) return undefined;
  const provenance = normalizeProvenance(value.provenance);
  if (!provenance) return undefined;
  return {
    value: { startLocal: window.startLocal, endLocal: window.endLocal },
    provenance,
  };
}

function normalizeQuietHoursEntry(
  value: unknown,
): OwnerFactEntry<OwnerQuietHours> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const quiet = isQuietHours(value.value) ? value.value : null;
  if (!quiet) return undefined;
  const provenance = normalizeProvenance(value.provenance);
  if (!provenance) return undefined;
  return {
    value: {
      startLocal: quiet.startLocal,
      endLocal: quiet.endLocal,
      timezone: quiet.timezone,
    },
    provenance,
  };
}

function normalizeReminderIntensityEntry(
  value: unknown,
): OwnerFactEntry<ReminderIntensity> | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (!isReminderIntensity(value.value)) return undefined;
  const provenance = normalizeProvenance(value.provenance);
  if (!provenance) return undefined;
  return { value: value.value, provenance };
}

function normalizeEscalationRule(value: unknown): EscalationRule | null {
  if (!isPlainRecord(value)) return null;
  const definitionId =
    typeof value.definitionId === "string" && value.definitionId.length > 0
      ? value.definitionId
      : null;
  const timeoutMinutes =
    typeof value.timeoutMinutes === "number" && value.timeoutMinutes >= 0
      ? Math.floor(value.timeoutMinutes)
      : null;
  const callAfterMinutes =
    typeof value.callAfterMinutes === "number" && value.callAfterMinutes >= 0
      ? Math.floor(value.callAfterMinutes)
      : null;
  if (timeoutMinutes === null && callAfterMinutes === null) {
    return null;
  }
  return { definitionId, timeoutMinutes, callAfterMinutes };
}

function normalizeEscalationRulesEntry(
  value: unknown,
): OwnerFactEntry<EscalationRule[]> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const rules = Array.isArray(value.value)
    ? value.value
        .map(normalizeEscalationRule)
        .filter((rule): rule is EscalationRule => rule !== null)
    : [];
  if (rules.length === 0) return undefined;
  const provenance = normalizeProvenance(value.provenance);
  if (!provenance) return undefined;
  return { value: rules, provenance };
}

function normalizeRecord(value: unknown): PersistedRecord {
  if (!isPlainRecord(value) || !isPlainRecord(value.facts)) {
    return emptyRecord();
  }
  const stored = value.facts;
  const facts: OwnerFacts = {};
  const stringFields = [
    "preferredName",
    "relationshipStatus",
    "partnerName",
    "orientation",
    "gender",
    "age",
    "location",
    "travelBookingPreferences",
    "preferredNotificationChannel",
    "locale",
    "timezone",
  ] as const;
  for (const field of stringFields) {
    const entry = normalizeStringEntry(stored[field]);
    if (entry) {
      facts[field] = entry;
    }
  }
  const morning = normalizeWindowEntry(stored.morningWindow);
  if (morning) facts.morningWindow = morning;
  const evening = normalizeWindowEntry(stored.eveningWindow);
  if (evening) facts.eveningWindow = evening;
  const quiet = normalizeQuietHoursEntry(stored.quietHours);
  if (quiet) facts.quietHours = quiet;
  const intensity = normalizeReminderIntensityEntry(stored.reminderIntensity);
  if (intensity) facts.reminderIntensity = intensity;
  const escalation = normalizeEscalationRulesEntry(stored.escalationRules);
  if (escalation) facts.escalationRules = escalation;
  return { schemaVersion: 1, facts };
}

// --- Patch normalization --------------------------------------------------

function trimNonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isWindowPatch(value: unknown): value is OwnerFactWindow {
  return isWindow(value);
}

function isQuietHoursPatch(value: unknown): value is OwnerQuietHours {
  return isQuietHours(value);
}

interface NormalizedPatch {
  strings: Partial<
    Record<
      | "preferredName"
      | "relationshipStatus"
      | "partnerName"
      | "orientation"
      | "gender"
      | "age"
      | "location"
      | "travelBookingPreferences"
      | "preferredNotificationChannel"
      | "locale"
      | "timezone",
      string
    >
  >;
  morningWindow?: OwnerFactWindow;
  eveningWindow?: OwnerFactWindow;
  quietHours?: OwnerQuietHours;
}

function normalizePatch(patch: OwnerFactsPatch): NormalizedPatch {
  const strings: NormalizedPatch["strings"] = {};
  const result: NormalizedPatch = { strings };
  const stringFields = [
    "preferredName",
    "relationshipStatus",
    "partnerName",
    "orientation",
    "gender",
    "age",
    "location",
    "travelBookingPreferences",
    "preferredNotificationChannel",
    "locale",
    "timezone",
  ] as const;
  for (const field of stringFields) {
    const value = patch[field];
    if (typeof value === "string") {
      const trimmed = trimNonEmpty(value);
      if (trimmed) {
        strings[field] = trimmed;
      }
    }
  }
  if (isWindowPatch(patch.morningWindow)) {
    result.morningWindow = {
      startLocal: patch.morningWindow.startLocal,
      endLocal: patch.morningWindow.endLocal,
    };
  }
  if (isWindowPatch(patch.eveningWindow)) {
    result.eveningWindow = {
      startLocal: patch.eveningWindow.startLocal,
      endLocal: patch.eveningWindow.endLocal,
    };
  }
  if (isQuietHoursPatch(patch.quietHours)) {
    result.quietHours = {
      startLocal: patch.quietHours.startLocal,
      endLocal: patch.quietHours.endLocal,
      timezone: patch.quietHours.timezone,
    };
  }
  return result;
}

// --- Implementation -------------------------------------------------------

const LEGACY_PROFILE_FIELD_MAP = {
  preferredName: "name",
  relationshipStatus: "relationshipStatus",
  partnerName: "partnerName",
  orientation: "orientation",
  gender: "gender",
  age: "age",
  location: "location",
  travelBookingPreferences: "travelBookingPreferences",
} as const;

type FactStringField = keyof typeof LEGACY_PROFILE_FIELD_MAP;

function buildLegacyProfilePatch(
  strings: NormalizedPatch["strings"],
): LifeOpsOwnerProfilePatch {
  const legacyPatch: LifeOpsOwnerProfilePatch = {};
  for (const [factField, profileField] of Object.entries(
    LEGACY_PROFILE_FIELD_MAP,
  ) as Array<
    [FactStringField, (typeof LEGACY_PROFILE_FIELD_MAP)[FactStringField]]
  >) {
    const value = strings[factField];
    if (typeof value === "string") {
      legacyPatch[profileField] = value;
    }
  }
  return legacyPatch;
}

class CacheBackedOwnerFactStore implements OwnerFactStore {
  constructor(private readonly runtime: IAgentRuntime) {}

  async read(): Promise<OwnerFacts> {
    const record = await this.readRecord();
    return cloneFacts(record.facts);
  }

  async update(
    patch: OwnerFactsPatch,
    provenance: OwnerFactProvenance,
  ): Promise<OwnerFacts> {
    const normalized = normalizePatch(patch);
    const hasStringPatch = Object.keys(normalized.strings).length > 0;
    if (
      !hasStringPatch &&
      !normalized.morningWindow &&
      !normalized.eveningWindow &&
      !normalized.quietHours
    ) {
      const current = await this.read();
      return current;
    }

    const record = await this.readRecord();
    const next = cloneFacts(record.facts);

    const stringFields = [
      "preferredName",
      "relationshipStatus",
      "partnerName",
      "orientation",
      "gender",
      "age",
      "location",
      "travelBookingPreferences",
      "preferredNotificationChannel",
      "locale",
      "timezone",
    ] as const;
    for (const field of stringFields) {
      const value = normalized.strings[field];
      if (typeof value === "string") {
        next[field] = { value, provenance: { ...provenance } };
      }
    }
    if (normalized.morningWindow) {
      next.morningWindow = {
        value: { ...normalized.morningWindow },
        provenance: { ...provenance },
      };
    }
    if (normalized.eveningWindow) {
      next.eveningWindow = {
        value: { ...normalized.eveningWindow },
        provenance: { ...provenance },
      };
    }
    if (normalized.quietHours) {
      next.quietHours = {
        value: { ...normalized.quietHours },
        provenance: { ...provenance },
      };
    }

    await this.writeRecord({ schemaVersion: 1, facts: next });

    // Mirror identity-string fields onto the legacy LifeOpsOwnerProfile so
    // existing readers (calendar mixin, lifeops provider, memory test)
    // stay consistent. The mirror is best-effort: writing the canonical
    // store has already succeeded.
    if (hasStringPatch) {
      const legacyPatch = buildLegacyProfilePatch(normalized.strings);
      if (Object.keys(legacyPatch).length > 0) {
        await updateLifeOpsOwnerProfile(this.runtime, legacyPatch);
      }
      const namePatch = normalized.strings.preferredName;
      if (typeof namePatch === "string") {
        await persistConfiguredOwnerName(namePatch);
      }
    }

    return cloneFacts(next);
  }

  async setReminderIntensity(
    patch: PolicyPatchReminderIntensity,
    provenance: OwnerFactProvenance,
  ): Promise<OwnerFacts> {
    if (!isReminderIntensity(patch.intensity)) {
      throw new Error(
        `Unsupported reminder intensity "${String(patch.intensity)}"`,
      );
    }
    const record = await this.readRecord();
    const next = cloneFacts(record.facts);
    const policyProvenance: OwnerFactProvenance = patch.note
      ? { ...provenance, note: patch.note }
      : { ...provenance };
    next.reminderIntensity = {
      value: patch.intensity,
      provenance: policyProvenance,
    };
    await this.writeRecord({ schemaVersion: 1, facts: next });
    return cloneFacts(next);
  }

  async upsertEscalationRule(
    patch: PolicyPatchEscalationRule,
    provenance: OwnerFactProvenance,
  ): Promise<OwnerFacts> {
    const rule = normalizeEscalationRule(patch.rule);
    if (!rule) {
      throw new Error(
        "Escalation rule requires timeoutMinutes or callAfterMinutes",
      );
    }
    const record = await this.readRecord();
    const next = cloneFacts(record.facts);
    const existing = next.escalationRules?.value ?? [];
    const filtered = existing.filter(
      (r) => r.definitionId !== rule.definitionId,
    );
    filtered.push(rule);
    const policyProvenance: OwnerFactProvenance = patch.note
      ? { ...provenance, note: patch.note }
      : { ...provenance };
    next.escalationRules = {
      value: filtered,
      provenance: policyProvenance,
    };
    await this.writeRecord({ schemaVersion: 1, facts: next });
    return cloneFacts(next);
  }

  private async readRecord(): Promise<PersistedRecord> {
    const cache = asCacheRuntime(this.runtime);
    const stored = await cache.getCache<PersistedRecord>(FACT_STORE_CACHE_KEY);
    return normalizeRecord(stored);
  }

  private async writeRecord(record: PersistedRecord): Promise<void> {
    const cache = asCacheRuntime(this.runtime);
    await cache.setCache<PersistedRecord>(FACT_STORE_CACHE_KEY, record);
  }
}

function cloneFacts(facts: OwnerFacts): OwnerFacts {
  const next: OwnerFacts = {};
  if (facts.preferredName) {
    next.preferredName = cloneStringEntry(facts.preferredName);
  }
  if (facts.relationshipStatus) {
    next.relationshipStatus = cloneStringEntry(facts.relationshipStatus);
  }
  if (facts.partnerName) {
    next.partnerName = cloneStringEntry(facts.partnerName);
  }
  if (facts.orientation) {
    next.orientation = cloneStringEntry(facts.orientation);
  }
  if (facts.gender) next.gender = cloneStringEntry(facts.gender);
  if (facts.age) next.age = cloneStringEntry(facts.age);
  if (facts.location) next.location = cloneStringEntry(facts.location);
  if (facts.travelBookingPreferences) {
    next.travelBookingPreferences = cloneStringEntry(
      facts.travelBookingPreferences,
    );
  }
  if (facts.morningWindow) {
    next.morningWindow = cloneWindowEntry(facts.morningWindow);
  }
  if (facts.eveningWindow) {
    next.eveningWindow = cloneWindowEntry(facts.eveningWindow);
  }
  if (facts.quietHours) {
    next.quietHours = cloneQuietHoursEntry(facts.quietHours);
  }
  if (facts.preferredNotificationChannel) {
    next.preferredNotificationChannel = cloneStringEntry(
      facts.preferredNotificationChannel,
    );
  }
  if (facts.locale) next.locale = cloneStringEntry(facts.locale);
  if (facts.timezone) next.timezone = cloneStringEntry(facts.timezone);
  if (facts.reminderIntensity) {
    next.reminderIntensity = {
      value: facts.reminderIntensity.value,
      provenance: { ...facts.reminderIntensity.provenance },
    };
  }
  if (facts.escalationRules) {
    next.escalationRules = {
      value: facts.escalationRules.value.map((rule) => ({ ...rule })),
      provenance: { ...facts.escalationRules.provenance },
    };
  }
  return next;
}

function cloneStringEntry(
  entry: OwnerFactEntry<string>,
): OwnerFactEntry<string> {
  return { value: entry.value, provenance: { ...entry.provenance } };
}

function cloneWindowEntry(
  entry: OwnerFactEntry<OwnerFactWindow>,
): OwnerFactEntry<OwnerFactWindow> {
  return {
    value: { ...entry.value },
    provenance: { ...entry.provenance },
  };
}

function cloneQuietHoursEntry(
  entry: OwnerFactEntry<OwnerQuietHours>,
): OwnerFactEntry<OwnerQuietHours> {
  return {
    value: { ...entry.value },
    provenance: { ...entry.provenance },
  };
}

// --- Public factory -------------------------------------------------------

export function createOwnerFactStore(runtime: IAgentRuntime): OwnerFactStore {
  return new CacheBackedOwnerFactStore(runtime);
}

// --- Runtime registration -------------------------------------------------

const STORE_KEY = Symbol.for(
  "@elizaos/app-lifeops:owner-fact-store",
);

interface FactStoreHostRuntime extends IAgentRuntime {
  [STORE_KEY]?: OwnerFactStore;
}

export function registerOwnerFactStore(
  runtime: IAgentRuntime,
  store: OwnerFactStore,
): void {
  (runtime as FactStoreHostRuntime)[STORE_KEY] = store;
}

export function getOwnerFactStore(
  runtime: IAgentRuntime,
): OwnerFactStore | null {
  return (runtime as FactStoreHostRuntime)[STORE_KEY] ?? null;
}

/**
 * Resolve the registered store, falling back to a fresh instance when the
 * registry slot is empty (e.g. tests instantiating services without going
 * through `plugin.init`). Either way the underlying cache is the same, so
 * facts persist across the boundary.
 */
export function resolveOwnerFactStore(runtime: IAgentRuntime): OwnerFactStore {
  return getOwnerFactStore(runtime) ?? createOwnerFactStore(runtime);
}

// --- Convenience views ----------------------------------------------------

/**
 * Reduces a typed `OwnerFacts` record to the minimal `OwnerFactsView`
 * surface consumed by the `ScheduledTask` runner (gates and completion
 * checks). Provenance is intentionally dropped — readers want the value.
 */
export function ownerFactsToView(
  facts: OwnerFacts,
): import("../scheduled-task/types.js").OwnerFactsView {
  const view: import("../scheduled-task/types.js").OwnerFactsView = {};
  if (facts.preferredName) view.preferredName = facts.preferredName.value;
  if (facts.timezone) view.timezone = facts.timezone.value;
  if (facts.locale) view.locale = facts.locale.value;
  if (facts.morningWindow) {
    view.morningWindow = {
      start: facts.morningWindow.value.startLocal,
      end: facts.morningWindow.value.endLocal,
    };
  }
  if (facts.eveningWindow) {
    view.eveningWindow = {
      start: facts.eveningWindow.value.startLocal,
      end: facts.eveningWindow.value.endLocal,
    };
  }
  if (facts.quietHours) {
    view.quietHours = {
      start: facts.quietHours.value.startLocal,
      end: facts.quietHours.value.endLocal,
      tz: facts.quietHours.value.timezone,
    };
  }
  return view;
}
