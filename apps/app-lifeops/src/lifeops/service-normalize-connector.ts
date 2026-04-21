import type {
  LifeOpsBrowserKind,
  LifeOpsBrowserPermissionState,
  LifeOpsBrowserSettings,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  LifeOpsReminderStep,
  LifeOpsTimeWindowDefinition,
  LifeOpsWindowPolicy,
  LifeOpsWorkflowPermissionPolicy,
  LifeOpsWorkflowSchedule,
  LifeOpsWorkflowTriggerType,
  UpdateLifeOpsBrowserSettingsRequest,
} from "@elizaos/app-lifeops/contracts";
import {
  LIFEOPS_BROWSER_KINDS,
  LIFEOPS_BROWSER_SITE_ACCESS_MODES,
  LIFEOPS_BROWSER_TRACKING_MODES,
  LIFEOPS_CONNECTOR_MODES,
  LIFEOPS_CONNECTOR_SIDES,
  LIFEOPS_EVENT_KINDS,
  LIFEOPS_GOOGLE_CAPABILITIES,
  LIFEOPS_REMINDER_CHANNELS,
  LIFEOPS_TIME_WINDOW_NAMES,
  LIFEOPS_WORKFLOW_TRIGGER_TYPES,
} from "@elizaos/app-lifeops/contracts";
import { parseCronExpression } from "@elizaos/agent/triggers/scheduling";
import { LifeOpsServiceError } from "./service-types.js";
import {
  fail,
  normalizeEnumValue,
  normalizeFiniteNumber,
  normalizeIsoString,
  normalizeOptionalBoolean,
  normalizeOptionalIsoString,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeValidTimeZone,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  DAY_MINUTES,
  DEFAULT_BROWSER_PERMISSION_STATE,
  DEFAULT_WORKFLOW_PERMISSION_POLICY,
} from "./service-constants.js";
import { resolveDefaultTimeZone, resolveDefaultWindowPolicy } from "./defaults.js";
import { normalizeGoogleCapabilities } from "./google-scopes.js";

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value } as Record<string, unknown>;
}

function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, field);
}

function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = updates && typeof updates === "object" && !Array.isArray(updates)
    ? { ...updates }
    : {};
  const merged = {
    ...current,
    ...cloned,
  };
  if (
    typeof merged.privacyClass !== "string" ||
    merged.privacyClass.trim().length === 0
  ) {
    merged.privacyClass = "private";
  }
  if (merged.privacyClass === "private") {
    merged.publicContextBlocked = true;
  }
  return merged;
}

function normalizedStringSet(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

export function normalizeOptionalConnectorMode(
  value: unknown,
  field: string,
): LifeOpsConnectorMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeEnumValue(value, field, LIFEOPS_CONNECTOR_MODES);
}

export function normalizeOptionalConnectorSide(
  value: unknown,
  field: string,
): LifeOpsConnectorSide | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeEnumValue(value, field, LIFEOPS_CONNECTOR_SIDES);
}

export function normalizeGoogleCapabilityRequest(
  value: unknown,
): LifeOpsGoogleCapability[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(400, "capabilities must be an array");
  }
  const normalized: LifeOpsGoogleCapability[] = [];
  const seen = new Set<LifeOpsGoogleCapability>();
  for (const candidate of value) {
    const capability = normalizeEnumValue(
      candidate,
      "capabilities[]",
      LIFEOPS_GOOGLE_CAPABILITIES,
    );
    if (seen.has(capability)) {
      continue;
    }
    seen.add(capability);
    normalized.push(capability);
  }
  return normalizeGoogleCapabilities(normalized);
}

export function normalizeGrantCapabilities(
  capabilities: readonly string[],
): LifeOpsGoogleCapability[] {
  return normalizeGoogleCapabilities(capabilities);
}

export function normalizeWorkflowTriggerType(
  value: unknown,
): LifeOpsWorkflowTriggerType {
  return normalizeEnumValue(
    value,
    "triggerType",
    LIFEOPS_WORKFLOW_TRIGGER_TYPES,
  );
}

export function normalizeWorkflowSchedule(
  value: unknown,
  triggerType: LifeOpsWorkflowTriggerType,
): LifeOpsWorkflowSchedule {
  if (triggerType === "manual") {
    return { kind: "manual" };
  }
  const schedule = requireRecord(value, "schedule");
  if (triggerType === "event") {
    return normalizeEventTrigger(schedule);
  }
  const kind = normalizeEnumValue(schedule.kind, "schedule.kind", [
    "once",
    "interval",
    "cron",
  ] as const);
  if (kind === "once") {
    return {
      kind,
      runAt: normalizeIsoString(schedule.runAt, "schedule.runAt"),
      timezone: normalizeValidTimeZone(schedule.timezone, "schedule.timezone"),
    };
  }
  if (kind === "interval") {
    return {
      kind,
      everyMinutes: normalizePositiveInteger(
        schedule.everyMinutes,
        "schedule.everyMinutes",
      ),
      timezone: normalizeValidTimeZone(schedule.timezone, "schedule.timezone"),
    };
  }
  const cronExpression = requireNonEmptyString(
    schedule.cronExpression,
    "schedule.cronExpression",
  );
  if (!parseCronExpression(cronExpression)) {
    fail(
      400,
      "schedule.cronExpression must be a valid 5-field cron expression",
    );
  }
  return {
    kind,
    cronExpression,
    timezone: normalizeValidTimeZone(schedule.timezone, "schedule.timezone"),
  };
}

function normalizeEventTrigger(
  schedule: Record<string, unknown>,
): LifeOpsWorkflowSchedule {
  const kind = normalizeEnumValue(schedule.kind, "schedule.kind", [
    "event",
  ] as const);
  const eventKind = normalizeEnumValue(
    schedule.eventKind,
    "schedule.eventKind",
    LIFEOPS_EVENT_KINDS,
  );
  const rawFilters = schedule.filters;
  if (rawFilters === undefined || rawFilters === null) {
    return { kind, eventKind };
  }
  const filtersRecord = requireRecord(rawFilters, "schedule.filters");
  if (eventKind === "calendar.event.ended") {
    return {
      kind,
      eventKind,
      filters: {
        kind: "calendar.event.ended",
        filters: normalizeCalendarEventEndedFilters(filtersRecord),
      },
    };
  }
  return { kind, eventKind };
}

function normalizeCalendarEventEndedFilters(
  input: Record<string, unknown>,
) {
  const filters: {
    calendarIds?: string[];
    titleIncludesAny?: string[];
    minDurationMinutes?: number;
    attendeeEmailIncludesAny?: string[];
  } = {};
  if (input.calendarIds !== undefined) {
    filters.calendarIds = normalizeStringArray(
      input.calendarIds,
      "schedule.filters.calendarIds",
    );
  }
  if (input.titleIncludesAny !== undefined) {
    filters.titleIncludesAny = normalizeStringArray(
      input.titleIncludesAny,
      "schedule.filters.titleIncludesAny",
    );
  }
  if (input.minDurationMinutes !== undefined) {
    filters.minDurationMinutes = normalizePositiveInteger(
      input.minDurationMinutes,
      "schedule.filters.minDurationMinutes",
    );
  }
  if (input.attendeeEmailIncludesAny !== undefined) {
    filters.attendeeEmailIncludesAny = normalizeStringArray(
      input.attendeeEmailIncludesAny,
      "schedule.filters.attendeeEmailIncludesAny",
    );
  }
  return filters;
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of value) {
    out.push(requireNonEmptyString(entry, `${field}[]`));
  }
  return out;
}

export function normalizeWorkflowPermissionPolicy(
  value: unknown,
  current: LifeOpsWorkflowPermissionPolicy = DEFAULT_WORKFLOW_PERMISSION_POLICY,
): LifeOpsWorkflowPermissionPolicy {
  if (value === undefined) {
    return { ...current };
  }
  const input = requireRecord(value, "permissionPolicy");
  return {
    allowBrowserActions:
      normalizeOptionalBoolean(
        input.allowBrowserActions,
        "permissionPolicy.allowBrowserActions",
      ) ?? current.allowBrowserActions,
    trustedBrowserActions:
      normalizeOptionalBoolean(
        input.trustedBrowserActions,
        "permissionPolicy.trustedBrowserActions",
      ) ?? current.trustedBrowserActions,
    allowXPosts:
      normalizeOptionalBoolean(
        input.allowXPosts,
        "permissionPolicy.allowXPosts",
      ) ?? current.allowXPosts,
    trustedXPosting:
      normalizeOptionalBoolean(
        input.trustedXPosting,
        "permissionPolicy.trustedXPosting",
      ) ?? current.trustedXPosting,
    requireConfirmationForBrowserActions:
      normalizeOptionalBoolean(
        input.requireConfirmationForBrowserActions,
        "permissionPolicy.requireConfirmationForBrowserActions",
      ) ?? current.requireConfirmationForBrowserActions,
    requireConfirmationForXPosts:
      normalizeOptionalBoolean(
        input.requireConfirmationForXPosts,
        "permissionPolicy.requireConfirmationForXPosts",
      ) ?? current.requireConfirmationForXPosts,
  };
}

export function normalizeOptionalBrowserKind(
  value: unknown,
  field: string,
): LifeOpsBrowserKind | null {
  const browser = normalizeOptionalString(value);
  if (!browser) {
    return null;
  }
  return normalizeEnumValue(browser, field, LIFEOPS_BROWSER_KINDS);
}

export function normalizeBrowserPermissionStateInput(
  value: unknown,
  current: LifeOpsBrowserPermissionState = DEFAULT_BROWSER_PERMISSION_STATE,
): LifeOpsBrowserPermissionState {
  if (value === undefined) {
    return { ...current, grantedOrigins: [...current.grantedOrigins] };
  }
  const input = requireRecord(value, "permissions");
  const grantedOrigins = input.grantedOrigins;
  return {
    tabs:
      normalizeOptionalBoolean(input.tabs, "permissions.tabs") ?? current.tabs,
    scripting:
      normalizeOptionalBoolean(input.scripting, "permissions.scripting") ??
      current.scripting,
    activeTab:
      normalizeOptionalBoolean(input.activeTab, "permissions.activeTab") ??
      current.activeTab,
    allOrigins:
      normalizeOptionalBoolean(input.allOrigins, "permissions.allOrigins") ??
      current.allOrigins,
    grantedOrigins:
      grantedOrigins === undefined
        ? [...current.grantedOrigins]
        : normalizeBrowserPermissionGrantList(
            grantedOrigins,
            "permissions.grantedOrigins",
          ),
    incognitoEnabled:
      normalizeOptionalBoolean(
        input.incognitoEnabled,
        "permissions.incognitoEnabled",
      ) ?? current.incognitoEnabled,
  };
}

export function normalizeOrigin(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(400, `${field} must be a valid origin URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(400, `${field} must use http or https`);
  }
  return parsed.origin;
}

export function normalizeBrowserPermissionGrant(
  value: unknown,
  field: string,
): string {
  const text = requireNonEmptyString(value, field);
  const isHostPermissionPattern =
    /^(?:https?|file|ftp|chrome-extension|moz-extension):\/\/\S+$/i.test(text);

  if (text === "<all_urls>") {
    return text;
  }

  if (
    isHostPermissionPattern &&
    (text.includes("*") || !/^(?:https?):\/\//i.test(text))
  ) {
    return text;
  }

  try {
    return normalizeOrigin(text, field);
  } catch (error) {
    if (!(error instanceof LifeOpsServiceError) || error.status !== 400) {
      throw error;
    }
  }

  if (isHostPermissionPattern) {
    return text;
  }

  fail(
    400,
    `${field} must be a valid origin URL or browser host-permission pattern`,
  );
}

export function normalizeBrowserPermissionGrantList(
  value: unknown,
  field: string,
): string[] {
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return normalizedStringSet(
    value.map((candidate, index) =>
      normalizeBrowserPermissionGrant(candidate, `${field}[${index}]`),
    ),
  );
}

export function normalizeOriginList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  return normalizedStringSet(
    value.map((candidate, index) =>
      normalizeOrigin(candidate, `${field}[${index}]`),
    ),
  );
}

export function normalizeBrowserSettingsUpdate(
  request: UpdateLifeOpsBrowserSettingsRequest,
  current: LifeOpsBrowserSettings,
): LifeOpsBrowserSettings {
  return {
    enabled:
      normalizeOptionalBoolean(request.enabled, "enabled") ?? current.enabled,
    trackingMode:
      request.trackingMode === undefined
        ? current.trackingMode
        : normalizeEnumValue(
            request.trackingMode,
            "trackingMode",
            LIFEOPS_BROWSER_TRACKING_MODES,
          ),
    allowBrowserControl:
      normalizeOptionalBoolean(
        request.allowBrowserControl,
        "allowBrowserControl",
      ) ?? current.allowBrowserControl,
    requireConfirmationForAccountAffecting:
      normalizeOptionalBoolean(
        request.requireConfirmationForAccountAffecting,
        "requireConfirmationForAccountAffecting",
      ) ?? current.requireConfirmationForAccountAffecting,
    incognitoEnabled:
      normalizeOptionalBoolean(request.incognitoEnabled, "incognitoEnabled") ??
      current.incognitoEnabled,
    siteAccessMode:
      request.siteAccessMode === undefined
        ? current.siteAccessMode
        : normalizeEnumValue(
            request.siteAccessMode,
            "siteAccessMode",
            LIFEOPS_BROWSER_SITE_ACCESS_MODES,
          ),
    grantedOrigins:
      request.grantedOrigins === undefined
        ? [...current.grantedOrigins]
        : normalizeOriginList(request.grantedOrigins, "grantedOrigins"),
    blockedOrigins:
      request.blockedOrigins === undefined
        ? [...current.blockedOrigins]
        : normalizeOriginList(request.blockedOrigins, "blockedOrigins"),
    maxRememberedTabs:
      request.maxRememberedTabs === undefined
        ? current.maxRememberedTabs
        : (() => {
            const value = Math.trunc(
              normalizeFiniteNumber(
                request.maxRememberedTabs,
                "maxRememberedTabs",
              ),
            );
            if (value < 1 || value > 50) {
              fail(400, "maxRememberedTabs must be between 1 and 50");
            }
            return value;
          })(),
    pauseUntil:
      request.pauseUntil === undefined
        ? current.pauseUntil
        : (normalizeOptionalIsoString(request.pauseUntil, "pauseUntil") ??
          null),
    metadata:
      request.metadata === undefined
        ? current.metadata
        : mergeMetadata(
            current.metadata,
            normalizeOptionalRecord(request.metadata, "metadata"),
          ),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeWindowPolicyInput(
  value: unknown,
  field: string,
  timeZone: string,
): LifeOpsWindowPolicy {
  if (value === undefined || value === null) {
    return resolveDefaultWindowPolicy(timeZone);
  }
  const input = requireRecord(value, field);
  if (!Array.isArray(input.windows) || input.windows.length === 0) {
    fail(400, `${field}.windows must contain at least one window`);
  }
  const policyTimeZone = normalizeValidTimeZone(
    input.timezone,
    `${field}.timezone`,
    timeZone,
  );
  const seenNames = new Set<string>();
  const windows = input.windows.map((candidate, index) => {
    const windowInput = requireRecord(candidate, `${field}.windows[${index}]`);
    const name = normalizeEnumValue(
      windowInput.name,
      `${field}.windows[${index}].name`,
      LIFEOPS_TIME_WINDOW_NAMES,
    );
    if (seenNames.has(name)) {
      fail(400, `${field}.windows contains duplicate name "${name}"`);
    }
    seenNames.add(name);
    const label = requireNonEmptyString(
      windowInput.label,
      `${field}.windows[${index}].label`,
    );
    const startMinute = Math.trunc(
      normalizeFiniteNumber(
        windowInput.startMinute,
        `${field}.windows[${index}].startMinute`,
      ),
    );
    const endMinute = Math.trunc(
      normalizeFiniteNumber(
        windowInput.endMinute,
        `${field}.windows[${index}].endMinute`,
      ),
    );
    if (startMinute < 0 || startMinute >= DAY_MINUTES * 2) {
      fail(
        400,
        `${field}.windows[${index}].startMinute must be between 0 and 2879`,
      );
    }
    if (endMinute <= startMinute || endMinute > DAY_MINUTES * 2) {
      fail(
        400,
        `${field}.windows[${index}].endMinute must be greater than startMinute and at most 2880`,
      );
    }
    return {
      name,
      label,
      startMinute,
      endMinute,
    } satisfies LifeOpsTimeWindowDefinition;
  });
  return {
    timezone: policyTimeZone,
    windows,
  };
}

export function normalizeQuietHoursInput(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  const input = requireRecord(value, field);
  if (Object.keys(input).length === 0) {
    return {};
  }
  const timezone = normalizeValidTimeZone(
    input.timezone,
    `${field}.timezone`,
    resolveDefaultTimeZone(),
  );
  const startMinute = Math.trunc(
    normalizeFiniteNumber(input.startMinute, `${field}.startMinute`),
  );
  const endMinute = Math.trunc(
    normalizeFiniteNumber(input.endMinute, `${field}.endMinute`),
  );
  if (startMinute < 0 || startMinute >= DAY_MINUTES) {
    fail(400, `${field}.startMinute must be between 0 and 1439`);
  }
  if (endMinute < 0 || endMinute >= DAY_MINUTES) {
    fail(400, `${field}.endMinute must be between 0 and 1439`);
  }
  let channels: LifeOpsReminderStep["channel"][] | undefined;
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels)) {
      fail(400, `${field}.channels must be an array`);
    }
    const seen = new Set<LifeOpsReminderStep["channel"]>();
    channels = [];
    for (const [index, candidate] of input.channels.entries()) {
      const channel = normalizeEnumValue(
        candidate,
        `${field}.channels[${index}]`,
        LIFEOPS_REMINDER_CHANNELS,
      );
      if (seen.has(channel)) {
        continue;
      }
      seen.add(channel);
      channels.push(channel);
    }
  }
  return {
    timezone,
    startMinute,
    endMinute,
    ...(channels !== undefined ? { channels } : {}),
  };
}
