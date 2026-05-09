import { loadElizaConfig, saveElizaConfig } from "@elizaos/agent";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";

const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";
export const OWNER_NAME_MAX_LENGTH = 60;
const OWNER_PROFILE_VALUE_MAX_LENGTH = 120;

export const LIFEOPS_OWNER_PROFILE_FIELDS = [
  "name",
  "relationshipStatus",
  "partnerName",
  "orientation",
  "gender",
  "age",
  "location",
  "travelBookingPreferences",
  // T9f — Morning/night check-in engine (plan §6.23). HH:MM strings in the
  // owner's local timezone; consumed by the check-in schedule resolver.
  "morningCheckinTime",
  "nightCheckinTime",
] as const;

export type LifeOpsOwnerProfileField =
  (typeof LIFEOPS_OWNER_PROFILE_FIELDS)[number];

export type LifeOpsOwnerProfilePatch = Partial<
  Record<LifeOpsOwnerProfileField, string>
>;

export type LifeOpsOwnerProfile = Record<LifeOpsOwnerProfileField, string> & {
  updatedAt: string | null;
};

const DEFAULT_OWNER_PROFILE: LifeOpsOwnerProfile = {
  name: "admin",
  relationshipStatus: "n/a",
  partnerName: "n/a",
  orientation: "n/a",
  gender: "n/a",
  age: "n/a",
  location: "n/a",
  travelBookingPreferences: "n/a",
  morningCheckinTime: "",
  nightCheckinTime: "",
  updatedAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProfileValue(
  value: unknown,
  maxLength = OWNER_PROFILE_VALUE_MAX_LENGTH,
): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function isLifeOpsSchedulerTask(task: Task): boolean {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  return (
    task.name === LIFEOPS_TASK_NAME &&
    isRecord(metadata?.lifeopsScheduler) &&
    metadata.lifeopsScheduler.kind === "runtime_runner"
  );
}

function buildFallbackSchedulerMetadata(
  agentId: UUID,
): Record<string, unknown> {
  const intervalMs = resolveLifeOpsTaskIntervalMs(agentId);
  return {
    updateInterval: intervalMs,
    baseInterval: intervalMs,
    blocking: true,
    lifeopsScheduler: {
      kind: "runtime_runner",
      version: 1,
    },
  };
}

function readConfiguredOwnerNameFromConfig(): string | null {
  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : null;
    return normalizeProfileValue(ui?.ownerName, OWNER_NAME_MAX_LENGTH);
  } catch {
    return null;
  }
}

function writeConfiguredOwnerNameToConfig(name: string): boolean {
  const normalized = normalizeProfileValue(name, OWNER_NAME_MAX_LENGTH);
  if (!normalized) {
    return false;
  }

  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const nextUi = isRecord(config.ui) ? config.ui : {};
    saveElizaConfig({
      ...config,
      ui: {
        ...nextUi,
        ownerName: normalized,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function readLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
): Promise<Task | null> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...LIFEOPS_TASK_TAGS],
  });
  return tasks.find(isLifeOpsSchedulerTask) ?? null;
}

export function normalizeLifeOpsOwnerProfilePatch(
  patch: Record<string, unknown> | LifeOpsOwnerProfilePatch | null | undefined,
): LifeOpsOwnerProfilePatch {
  if (!patch) {
    return {};
  }

  const normalized: LifeOpsOwnerProfilePatch = {};
  for (const field of LIFEOPS_OWNER_PROFILE_FIELDS) {
    const value = normalizeProfileValue(
      patch[field],
      field === "name" ? OWNER_NAME_MAX_LENGTH : OWNER_PROFILE_VALUE_MAX_LENGTH,
    );
    if (value) {
      normalized[field] = value;
    }
  }
  return normalized;
}

export async function fetchConfiguredOwnerName(): Promise<string | null> {
  const fromConfig = readConfiguredOwnerNameFromConfig();
  if (fromConfig) {
    return fromConfig;
  }

  try {
    const response = await fetch(`http://localhost:${API_PORT}/api/config`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return null;
    }
    const config = (await response.json()) as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : null;
    return normalizeProfileValue(ui?.ownerName, OWNER_NAME_MAX_LENGTH);
  } catch {
    return null;
  }
}

export async function persistConfiguredOwnerName(
  name: string,
): Promise<boolean> {
  const normalized = normalizeProfileValue(name, OWNER_NAME_MAX_LENGTH);
  if (!normalized) {
    return false;
  }

  const savedToConfig = writeConfiguredOwnerNameToConfig(normalized);
  try {
    const response = await fetch(`http://localhost:${API_PORT}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui: { ownerName: normalized } }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok || savedToConfig;
  } catch {
    return savedToConfig;
  }
}

export function resolveLifeOpsOwnerProfile(
  metadata: Record<string, unknown> | null | undefined,
  configuredName?: string | null,
): LifeOpsOwnerProfile {
  const ownerProfile = isRecord(metadata?.ownerProfile)
    ? metadata.ownerProfile
    : null;
  const normalized = normalizeLifeOpsOwnerProfilePatch(ownerProfile);
  const updatedAt =
    ownerProfile && typeof ownerProfile.updatedAt === "string"
      ? normalizeProfileValue(ownerProfile.updatedAt, 64)
      : null;

  return {
    ...DEFAULT_OWNER_PROFILE,
    ...(configuredName ? { name: configuredName } : {}),
    ...normalized,
    updatedAt,
  };
}

export async function readLifeOpsOwnerProfile(
  runtime: IAgentRuntime,
): Promise<LifeOpsOwnerProfile> {
  const [configuredName, task] = await Promise.all([
    fetchConfiguredOwnerName(),
    readLifeOpsSchedulerTask(runtime),
  ]);
  const metadata = isRecord(task?.metadata) ? task.metadata : null;
  return resolveLifeOpsOwnerProfile(metadata, configuredName);
}

export interface LifeOpsCalendarFeedPreferences {
  calendarFeedIncludes: Record<string, boolean>;
  updatedAt: string | null;
}

const DEFAULT_CALENDAR_FEED_PREFERENCES: LifeOpsCalendarFeedPreferences = {
  calendarFeedIncludes: {},
  updatedAt: null,
};

/**
 * Preference key for a calendar under a specific account grant. Google returns
 * `calendarId: "primary"` for every account's primary calendar, so keying on
 * `calendarId` alone would collide across multi-account users. The grantId
 * disambiguates the account.
 */
export function calendarFeedPreferenceKey(
  grantId: string,
  calendarId: string,
): string {
  return `${grantId}:${calendarId}`;
}

export interface CalendarFeedPreferenceIdentifier {
  grantId: string;
  calendarId: string;
}

function normalizeCalendarFeedIncludes(
  value: unknown,
): Record<string, boolean> {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: Record<string, boolean> = {};
  for (const [rawCalendarId, rawIncluded] of Object.entries(value)) {
    const calendarId = rawCalendarId.trim();
    if (!calendarId || typeof rawIncluded !== "boolean") {
      continue;
    }
    normalized[calendarId] = rawIncluded;
  }
  return normalized;
}

function resolveCalendarFeedPreferences(
  metadata: Record<string, unknown> | null | undefined,
): LifeOpsCalendarFeedPreferences {
  const stored = isRecord(metadata?.calendarFeedPreferences)
    ? metadata.calendarFeedPreferences
    : null;
  const updatedAt =
    stored && typeof stored.updatedAt === "string"
      ? normalizeProfileValue(stored.updatedAt, 64)
      : null;
  return {
    ...DEFAULT_CALENDAR_FEED_PREFERENCES,
    calendarFeedIncludes: normalizeCalendarFeedIncludes(
      stored?.calendarFeedIncludes,
    ),
    updatedAt,
  };
}

export async function readLifeOpsCalendarFeedPreferences(
  runtime: IAgentRuntime,
): Promise<LifeOpsCalendarFeedPreferences> {
  const task = await readLifeOpsSchedulerTask(runtime);
  const metadata = isRecord(task?.metadata) ? task.metadata : null;
  return resolveCalendarFeedPreferences(metadata);
}

function normalizeCalendarFeedIdentifiers(
  identifiers: readonly CalendarFeedPreferenceIdentifier[],
): CalendarFeedPreferenceIdentifier[] {
  const seen = new Set<string>();
  const result: CalendarFeedPreferenceIdentifier[] = [];
  for (const id of identifiers) {
    const grantId = typeof id?.grantId === "string" ? id.grantId.trim() : "";
    const calendarId =
      typeof id?.calendarId === "string" ? id.calendarId.trim() : "";
    if (!grantId || !calendarId) {
      continue;
    }
    const key = calendarFeedPreferenceKey(grantId, calendarId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ grantId, calendarId });
  }
  return result;
}

export async function ensureLifeOpsCalendarFeedIncludes(
  runtime: IAgentRuntime,
  identifiers: readonly CalendarFeedPreferenceIdentifier[],
): Promise<LifeOpsCalendarFeedPreferences> {
  const normalizedIdentifiers = normalizeCalendarFeedIdentifiers(identifiers);
  const task = await readLifeOpsSchedulerTask(runtime);
  const currentMetadata = isRecord(task?.metadata) ? task.metadata : null;
  const current = resolveCalendarFeedPreferences(currentMetadata);
  const missingIdentifiers = normalizedIdentifiers.filter(
    ({ grantId, calendarId }) =>
      !(
        calendarFeedPreferenceKey(grantId, calendarId) in
        current.calendarFeedIncludes
      ),
  );
  if (missingIdentifiers.length === 0) {
    return current;
  }

  const taskId = await ensureLifeOpsSchedulerTask(runtime);
  const metadata =
    currentMetadata && task?.id === taskId
      ? currentMetadata
      : buildFallbackSchedulerMetadata(runtime.agentId);
  const nextCalendarFeedIncludes = { ...current.calendarFeedIncludes };
  for (const { grantId, calendarId } of missingIdentifiers) {
    nextCalendarFeedIncludes[calendarFeedPreferenceKey(grantId, calendarId)] =
      true;
  }
  const next: LifeOpsCalendarFeedPreferences = {
    calendarFeedIncludes: nextCalendarFeedIncludes,
    updatedAt: new Date().toISOString(),
  };
  await runtime.updateTask(taskId, {
    metadata: {
      ...(metadata ?? {}),
      calendarFeedPreferences: next,
    },
  });
  return next;
}

export async function setLifeOpsCalendarFeedIncluded(
  runtime: IAgentRuntime,
  identifier: CalendarFeedPreferenceIdentifier,
  included: boolean,
): Promise<LifeOpsCalendarFeedPreferences> {
  const grantId =
    typeof identifier?.grantId === "string" ? identifier.grantId.trim() : "";
  const calendarId =
    typeof identifier?.calendarId === "string"
      ? identifier.calendarId.trim()
      : "";
  if (!grantId) {
    throw new Error("grantId is required");
  }
  if (!calendarId) {
    throw new Error("calendarId is required");
  }

  const taskId = await ensureLifeOpsSchedulerTask(runtime);
  const task = await readLifeOpsSchedulerTask(runtime);
  const metadata =
    isRecord(task?.metadata) && task.id === taskId
      ? task.metadata
      : buildFallbackSchedulerMetadata(runtime.agentId);
  const current = resolveCalendarFeedPreferences(metadata);
  const next: LifeOpsCalendarFeedPreferences = {
    calendarFeedIncludes: {
      ...current.calendarFeedIncludes,
      [calendarFeedPreferenceKey(grantId, calendarId)]: included,
    },
    updatedAt: new Date().toISOString(),
  };
  await runtime.updateTask(taskId, {
    metadata: {
      ...(metadata ?? {}),
      calendarFeedPreferences: next,
    },
  });
  return next;
}

/**
 * Meeting preferences — stored alongside the owner profile in the LifeOps
 * scheduler task's metadata. Consumed by scheduling-with-others actions to
 * propose candidate slots that respect the owner's working hours, blackout
 * windows (e.g. lunch, focus blocks), and travel buffer.
 */
export interface LifeOpsMeetingPreferencesBlackout {
  label: string;
  /** Local time-of-day in "HH:MM" 24h format (inclusive). */
  startLocal: string;
  /** Local time-of-day in "HH:MM" 24h format (exclusive). */
  endLocal: string;
  /** 0=Sun..6=Sat. Omit for every day. */
  daysOfWeek?: number[];
}

export interface LifeOpsMeetingPreferences {
  timeZone: string;
  preferredStartLocal: string;
  preferredEndLocal: string;
  defaultDurationMinutes: number;
  travelBufferMinutes: number;
  blackoutWindows: LifeOpsMeetingPreferencesBlackout[];
  updatedAt: string | null;
}

export type LifeOpsMeetingPreferencesPatch = Partial<
  Omit<LifeOpsMeetingPreferences, "updatedAt">
>;

const DEFAULT_MEETING_PREFERENCES: LifeOpsMeetingPreferences = {
  timeZone: "America/Los_Angeles",
  preferredStartLocal: "09:00",
  preferredEndLocal: "17:00",
  defaultDurationMinutes: 30,
  travelBufferMinutes: 0,
  blackoutWindows: [],
  updatedAt: null,
};

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeTimeOfDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return TIME_OF_DAY_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeBlackoutWindow(
  value: unknown,
): LifeOpsMeetingPreferencesBlackout | null {
  if (!isRecord(value)) return null;
  const label = normalizeProfileValue(value.label, 60);
  const startLocal = normalizeTimeOfDay(value.startLocal);
  const endLocal = normalizeTimeOfDay(value.endLocal);
  if (!label || !startLocal || !endLocal || startLocal >= endLocal) return null;
  let daysOfWeek: number[] | undefined;
  if (Array.isArray(value.daysOfWeek)) {
    const filtered = value.daysOfWeek.filter(
      (d): d is number => typeof d === "number" && d >= 0 && d <= 6,
    );
    if (filtered.length > 0) daysOfWeek = filtered;
  }
  return { label, startLocal, endLocal, ...(daysOfWeek ? { daysOfWeek } : {}) };
}

export function normalizeLifeOpsMeetingPreferencesPatch(
  patch:
    | Record<string, unknown>
    | LifeOpsMeetingPreferencesPatch
    | null
    | undefined,
): LifeOpsMeetingPreferencesPatch {
  if (!patch || !isRecord(patch)) return {};
  const out: LifeOpsMeetingPreferencesPatch = {};
  if (typeof patch.timeZone === "string") {
    const tz = patch.timeZone.trim();
    if (tz.length > 0 && tz.length <= 64) out.timeZone = tz;
  }
  const s = normalizeTimeOfDay(patch.preferredStartLocal);
  if (s) out.preferredStartLocal = s;
  const e = normalizeTimeOfDay(patch.preferredEndLocal);
  if (e) out.preferredEndLocal = e;
  if (
    typeof patch.defaultDurationMinutes === "number" &&
    patch.defaultDurationMinutes >= 5 &&
    patch.defaultDurationMinutes <= 480
  ) {
    out.defaultDurationMinutes = Math.floor(patch.defaultDurationMinutes);
  }
  if (
    typeof patch.travelBufferMinutes === "number" &&
    patch.travelBufferMinutes >= 0 &&
    patch.travelBufferMinutes <= 240
  ) {
    out.travelBufferMinutes = Math.floor(patch.travelBufferMinutes);
  }
  if (Array.isArray(patch.blackoutWindows)) {
    out.blackoutWindows = patch.blackoutWindows
      .map(normalizeBlackoutWindow)
      .filter((w): w is LifeOpsMeetingPreferencesBlackout => w !== null);
  }
  return out;
}

function resolveMeetingPreferences(
  metadata: Record<string, unknown> | null | undefined,
): LifeOpsMeetingPreferences {
  const stored = isRecord(metadata?.meetingPreferences)
    ? metadata.meetingPreferences
    : null;
  const normalized = normalizeLifeOpsMeetingPreferencesPatch(stored);
  const updatedAt =
    stored && typeof stored.updatedAt === "string"
      ? normalizeProfileValue(stored.updatedAt, 64)
      : null;
  return { ...DEFAULT_MEETING_PREFERENCES, ...normalized, updatedAt };
}

export async function readLifeOpsMeetingPreferences(
  runtime: IAgentRuntime,
): Promise<LifeOpsMeetingPreferences> {
  const task = await readLifeOpsSchedulerTask(runtime);
  const metadata = isRecord(task?.metadata) ? task.metadata : null;
  return resolveMeetingPreferences(metadata);
}

export async function updateLifeOpsMeetingPreferences(
  runtime: IAgentRuntime,
  patch: LifeOpsMeetingPreferencesPatch | Record<string, unknown>,
): Promise<LifeOpsMeetingPreferences | null> {
  const normalizedPatch = normalizeLifeOpsMeetingPreferencesPatch(patch);
  if (Object.keys(normalizedPatch).length === 0) return null;

  const taskId = await ensureLifeOpsSchedulerTask(runtime);
  const task = await readLifeOpsSchedulerTask(runtime);
  const metadata =
    isRecord(task?.metadata) && task.id === taskId
      ? task.metadata
      : buildFallbackSchedulerMetadata(runtime.agentId);

  const next: LifeOpsMeetingPreferences = {
    ...resolveMeetingPreferences(metadata),
    ...normalizedPatch,
    updatedAt: new Date().toISOString(),
  };
  await runtime.updateTask(taskId, {
    metadata: { ...(metadata ?? {}), meetingPreferences: next },
  });
  return next;
}

export async function updateLifeOpsOwnerProfile(
  runtime: IAgentRuntime,
  patch: LifeOpsOwnerProfilePatch | Record<string, unknown>,
): Promise<LifeOpsOwnerProfile | null> {
  const normalizedPatch = normalizeLifeOpsOwnerProfilePatch(patch);
  if (Object.keys(normalizedPatch).length === 0) {
    return null;
  }

  const taskId = await ensureLifeOpsSchedulerTask(runtime);
  const [configuredName, task] = await Promise.all([
    fetchConfiguredOwnerName(),
    readLifeOpsSchedulerTask(runtime),
  ]);

  const metadata =
    isRecord(task?.metadata) && task.id === taskId
      ? task.metadata
      : buildFallbackSchedulerMetadata(runtime.agentId);
  const nextProfile: LifeOpsOwnerProfile = {
    ...resolveLifeOpsOwnerProfile(metadata, configuredName),
    ...normalizedPatch,
    updatedAt: new Date().toISOString(),
  };

  await runtime.updateTask(taskId, {
    metadata: {
      ...(metadata ?? {}),
      ownerProfile: nextProfile,
    },
  });

  return nextProfile;
}
