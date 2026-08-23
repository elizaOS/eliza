/// <reference types="bun-types" />

/**
 * Native Apple Calendar bridge. Loads the platform native library (via the
 * capacitor-calendar macOS bridge policy) and exposes event read/write against
 * the local Calendar store as `FeatureResult`s, so `CalendarService` can treat
 * Apple as a provider alongside Google. Access is gated by the permissions
 * registry; on a host without the native library the operations fail closed.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as appleCalendarBridgePolicyImport from "@elizaos/capacitor-calendar/macos-bridge-policy";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  FeatureResult,
  IPermissionsRegistry,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventAttendee,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsCalendarWriteOnlyCreateReceipt,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  type NativeLibraryCandidate,
  resolveNativeLibraryCandidate,
} from "@elizaos/shared/platform/native-library-policy";

const PERMISSIONS_REGISTRY_SERVICE = "eliza_permissions_registry";

export const APPLE_CALENDAR_PROVIDER = "apple_calendar" as const;
export const APPLE_CALENDAR_GRANT_ID = "apple-calendar";
export const APPLE_CALENDAR_ACCOUNT_LABEL = "Apple Calendar";

type NativeCalendarAttendee = Partial<LifeOpsCalendarEventAttendee>;

type NativeCalendarEvent = {
  id?: string;
  externalId?: string;
  calendarId?: string;
  calendarSummary?: string;
  title?: string;
  description?: string;
  location?: string;
  status?: string;
  availability?:
    | "not_supported"
    | "busy"
    | "free"
    | "tentative"
    | "unavailable"
    | "unknown";
  startAt?: string;
  endAt?: string;
  isAllDay?: boolean;
  timezone?: string | null;
  htmlLink?: string | null;
  conferenceLink?: string | null;
  organizer?: Record<string, unknown> | null;
  attendees?: NativeCalendarAttendee[];
  iCalUID?: string | null;
  originalStartAt?: string | null;
  lastModifiedAt?: string | null;
  recurrenceRules?: Array<{
    frequency?: string;
    interval?: number;
    occurrenceCount?: number | null;
    endDate?: string | null;
  }>;
  reminders?: Array<{
    relativeOffsetSeconds?: number | null;
    absoluteDate?: string | null;
    locationTitle?: string | null;
  }>;
  sourceIdentifier?: string | null;
  sourceTitle?: string | null;
  sourceType?: string | null;
};

type NativeCalendarSummary = {
  calendarId?: string;
  summary?: string;
  description?: string | null;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string | null;
  foregroundColor?: string | null;
  timeZone?: string | null;
  selected?: boolean;
  sourceIdentifier?: string | null;
  sourceTitle?: string | null;
  sourceType?: string | null;
};

type NativeCalendarPayload = {
  ok: boolean;
  error?: string;
  message?: string;
  calendars?: NativeCalendarSummary[];
  events?: NativeCalendarEvent[];
  event?: NativeCalendarEvent;
  receipt?: NativeCalendarCreateReceipt;
};

type NativeCalendarPermissionPayload = {
  calendar: "granted" | "write_only" | "denied" | "prompt" | "restricted";
  canRequest: boolean;
  reason?: string | null;
};

type NativeCalendarCreateReceipt =
  | {
      accessLevel: "write_only";
      destination: "default_calendar";
      eventId: null;
      readBackAvailable: false;
    }
  | {
      accessLevel: "full_access";
      destination: "resolved_calendar";
      eventId: string;
      readBackAvailable: true;
    };

type NativeCalendarBridge = {
  platform: string;
  checkPermissions(): Promise<NativeCalendarPermissionPayload>;
  listCalendars(): Promise<NativeCalendarPayload>;
  listEvents(args: {
    calendarId?: string | null;
    timeMin: string;
    timeMax: string;
  }): Promise<NativeCalendarPayload>;
  createEvent(
    payload: NativeCalendarCreateEventPayload,
  ): Promise<NativeCalendarPayload>;
  updateEvent(
    eventId: string,
    payload: NativeCalendarEventPayload,
  ): Promise<NativeCalendarPayload>;
  deleteEvent(eventId: string): Promise<NativeCalendarPayload>;
  addListener?(
    eventName: "calendarStoreChanged",
    listener: (event: { observedAt: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
};

type NativeCalendarCreateEventPayload = {
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone?: string;
  isAllDay?: boolean;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
};

type NativeCalendarEventPayload = Partial<NativeCalendarCreateEventPayload>;

export type NativeAppleCalendarCreateOutcome =
  | {
      kind: "event";
      event: LifeOpsCalendarEvent;
    }
  | {
      kind: "accepted_without_readback";
      receipt: LifeOpsCalendarWriteOnlyCreateReceipt;
    };

type MacCalendarBridge = {
  listCalendars(): string | null;
  listEvents(
    calendarId: string,
    startSeconds: number,
    endSeconds: number,
  ): string | null;
  createEvent(payloadJson: string): string | null;
  updateEvent(eventId: string, payloadJson: string): string | null;
  deleteEvent(eventId: string): string | null;
};

let macCalendarBridge: MacCalendarBridge | null | undefined;
let macCalendarBridgeOverride: MacCalendarBridge | null | undefined;
let nativeBridgeOverride: NativeCalendarBridge | null | undefined;

const MODULE_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));

type AppleCalendarModule = typeof import("@elizaos/capacitor-calendar");
type AppleCalendarBridgePolicyModule =
  typeof import("@elizaos/capacitor-calendar/macos-bridge-policy");

function unwrapInteropDefault<TModule extends object>(
  module: TModule | { default?: TModule },
  namedExport: keyof TModule,
): TModule {
  if (namedExport in module) return module as TModule;
  return (module as { default?: TModule }).default ?? (module as TModule);
}

const appleCalendarBridgePolicy =
  unwrapInteropDefault<AppleCalendarBridgePolicyModule>(
    appleCalendarBridgePolicyImport,
    "APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME",
  );

const {
  APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME,
  appleCalendarMacosBridgeCandidates,
} = appleCalendarBridgePolicy;

function nativeDylibCandidates(): NativeLibraryCandidate[] {
  return appleCalendarMacosBridgeCandidates({
    envDylibPath:
      typeof process !== "undefined"
        ? (process.env.ELIZA_NATIVE_PERMISSIONS_DYLIB ?? "")
        : "",
  });
}

function hasNodeDarwinProcess(): boolean {
  return typeof process !== "undefined" && process.platform === "darwin";
}

function cStringBuffer(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(bytes.byteLength + 1);
  bytes.copy(buffer);
  return buffer;
}

function detectRuntimePlatform(): string {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  const capacitor = (
    globalThis as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  const platform = capacitor?.getPlatform?.();
  return typeof platform === "string" && platform ? platform : "web";
}

async function loadMacCalendarBridge(): Promise<MacCalendarBridge | null> {
  if (macCalendarBridgeOverride !== undefined) {
    return macCalendarBridgeOverride;
  }
  if (macCalendarBridge !== undefined) return macCalendarBridge;
  macCalendarBridge = null;
  if (!hasNodeDarwinProcess()) return null;

  for (const candidate of nativeDylibCandidates()) {
    const dylibPath = resolveNativeLibraryCandidate(candidate, {
      expectedBasename: APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME,
      moduleDir: MODULE_DIR,
      warn: (message) => logger.warn(`[AppleCalendar] ${message}`),
    });
    if (!dylibPath) continue;

    try {
      const { CString, FFIType, dlopen, ptr } = await import("bun:ffi");
      const lib = dlopen(dylibPath, {
        listAppleCalendarsJson: { args: [], returns: FFIType.ptr },
        listAppleCalendarEventsJson: {
          args: [FFIType.ptr, FFIType.f64, FFIType.f64],
          returns: FFIType.ptr,
        },
        createAppleCalendarEventJson: {
          args: [FFIType.ptr],
          returns: FFIType.ptr,
        },
        updateAppleCalendarEventJson: {
          args: [FFIType.ptr, FFIType.ptr],
          returns: FFIType.ptr,
        },
        deleteAppleCalendarEventJson: {
          args: [FFIType.ptr],
          returns: FFIType.ptr,
        },
        freeNativeCString: { args: [FFIType.ptr], returns: FFIType.void },
      });

      const takeNativeString = (value: unknown): string | null => {
        if (!value) return null;
        try {
          return new CString(value as never).toString();
        } finally {
          lib.symbols.freeNativeCString(value as never);
        }
      };

      macCalendarBridge = {
        listCalendars() {
          return takeNativeString(lib.symbols.listAppleCalendarsJson());
        },
        listEvents(calendarId, startSeconds, endSeconds) {
          const id = cStringBuffer(calendarId);
          return takeNativeString(
            lib.symbols.listAppleCalendarEventsJson(
              ptr(id),
              startSeconds,
              endSeconds,
            ),
          );
        },
        createEvent(payloadJson) {
          const payload = cStringBuffer(payloadJson);
          return takeNativeString(
            lib.symbols.createAppleCalendarEventJson(ptr(payload)),
          );
        },
        updateEvent(eventId, payloadJson) {
          const id = cStringBuffer(eventId);
          const payload = cStringBuffer(payloadJson);
          return takeNativeString(
            lib.symbols.updateAppleCalendarEventJson(ptr(id), ptr(payload)),
          );
        },
        deleteEvent(eventId) {
          const id = cStringBuffer(eventId);
          return takeNativeString(
            lib.symbols.deleteAppleCalendarEventJson(ptr(id)),
          );
        },
      };
      return macCalendarBridge;
    } catch (err) {
      logger.warn({ err }, "[AppleCalendar] Failed to load native bridge");
    }
  }
  return null;
}

function parseNativePayload(raw: string | null): NativeCalendarPayload {
  if (!raw) {
    return {
      ok: false,
      error: "native_error",
      message: "Native Apple Calendar bridge returned no response.",
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NativeCalendarPayload>;
    return normalizeNativePayload(parsed);
  } catch {
    return {
      ok: false,
      error: "native_error",
      message: "Native Apple Calendar bridge returned invalid JSON.",
    };
  }
}

function normalizeNativePayload(
  parsed: Partial<NativeCalendarPayload>,
): NativeCalendarPayload {
  return {
    ok: parsed.ok === true,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
    message: typeof parsed.message === "string" ? parsed.message : undefined,
    calendars: Array.isArray(parsed.calendars) ? parsed.calendars : undefined,
    events: Array.isArray(parsed.events) ? parsed.events : undefined,
    event:
      parsed.event && typeof parsed.event === "object"
        ? parsed.event
        : undefined,
    receipt: normalizeNativeCreateReceipt(parsed.receipt),
  };
}

function normalizeNativeCreateReceipt(
  value: unknown,
): NativeCalendarCreateReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.accessLevel === "write_only" &&
    receipt.destination === "default_calendar" &&
    receipt.eventId === null &&
    receipt.readBackAvailable === false
  ) {
    return {
      accessLevel: "write_only",
      destination: "default_calendar",
      eventId: null,
      readBackAvailable: false,
    };
  }
  if (
    receipt.accessLevel === "full_access" &&
    receipt.destination === "resolved_calendar" &&
    typeof receipt.eventId === "string" &&
    receipt.eventId.trim().length > 0 &&
    receipt.readBackAvailable === true
  ) {
    return {
      accessLevel: "full_access",
      destination: "resolved_calendar",
      eventId: receipt.eventId,
      readBackAvailable: true,
    };
  }
  return undefined;
}

function epochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : Number.NaN;
}

async function loadIosCalendarBridge(): Promise<NativeCalendarBridge | null> {
  const capacitor = (
    globalThis as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  if (capacitor?.getPlatform?.() !== "ios") return null;
  try {
    const { AppleCalendar } = unwrapInteropDefault<AppleCalendarModule>(
      await import("@elizaos/capacitor-calendar"),
      "AppleCalendar",
    );
    return {
      platform: "ios",
      async checkPermissions() {
        return AppleCalendar.checkPermissions();
      },
      async listCalendars() {
        return normalizeNativePayload(await AppleCalendar.listCalendars());
      },
      async listEvents(args) {
        return normalizeNativePayload(await AppleCalendar.listEvents(args));
      },
      async createEvent(payload) {
        return normalizeNativePayload(await AppleCalendar.createEvent(payload));
      },
      async updateEvent(eventId, payload) {
        return normalizeNativePayload(
          await AppleCalendar.updateEvent({ eventId, ...payload }),
        );
      },
      async deleteEvent(eventId) {
        return normalizeNativePayload(
          await AppleCalendar.deleteEvent({ eventId }),
        );
      },
      async addListener(eventName, listener) {
        return AppleCalendar.addListener(eventName, listener);
      },
    };
  } catch {
    return null;
  }
}

export async function subscribeNativeAppleCalendarChanges(
  listener: (event: { observedAt: string }) => void,
): Promise<{ remove: () => Promise<void> } | null> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge?.addListener) return null;
  return bridge.addListener("calendarStoreChanged", listener);
}

async function loadNativeCalendarBridge(): Promise<NativeCalendarBridge | null> {
  if (nativeBridgeOverride !== undefined) {
    return nativeBridgeOverride;
  }
  const iosBridge = await loadIosCalendarBridge();
  if (iosBridge) return iosBridge;

  const macBridge = await loadMacCalendarBridge();
  if (!macBridge) return null;
  return {
    platform: "darwin",
    async checkPermissions() {
      return { calendar: "granted", canRequest: false };
    },
    async listCalendars() {
      return parseNativePayload(macBridge.listCalendars());
    },
    async listEvents(args) {
      return parseNativePayload(
        macBridge.listEvents(
          args.calendarId ?? "",
          epochSeconds(args.timeMin),
          epochSeconds(args.timeMax),
        ),
      );
    },
    async createEvent(payload) {
      return parseNativePayload(macBridge.createEvent(JSON.stringify(payload)));
    },
    async updateEvent(eventId, payload) {
      return parseNativePayload(
        macBridge.updateEvent(eventId, JSON.stringify(payload)),
      );
    },
    async deleteEvent(eventId) {
      return parseNativePayload(macBridge.deleteEvent(eventId));
    },
  };
}

function getRegistryFromRuntime(
  runtime: IAgentRuntime | null | undefined,
): IPermissionsRegistry | null {
  if (!runtime) return null;
  const service = runtime.getService(PERMISSIONS_REGISTRY_SERVICE);
  if (!isPermissionsRegistry(service)) return null;
  return service;
}

function isPermissionsRegistry(
  service: unknown,
): service is IPermissionsRegistry {
  return (
    typeof service === "object" &&
    service !== null &&
    "get" in service &&
    typeof service.get === "function" &&
    "recordBlock" in service &&
    typeof service.recordBlock === "function"
  );
}

function buildPermissionFailure(
  runtime: IAgentRuntime | null | undefined,
  action: string,
): Extract<FeatureResult<never>, { reason: "permission" }> {
  const registry = getRegistryFromRuntime(runtime);
  let canRequest = true;
  if (registry) {
    registry.recordBlock("calendar", { app: "lifeops", action });
    const state = registry.get("calendar");
    canRequest = state.canRequest;
  }
  return {
    ok: false,
    reason: "permission",
    permission: "calendar",
    canRequest,
  };
}

function nativeFailure<T>(
  payload: NativeCalendarPayload,
  runtime: IAgentRuntime | null | undefined,
  action: string,
): FeatureResult<T> {
  if (payload.error === "permission") {
    return buildPermissionFailure(runtime, action);
  }
  return {
    ok: false,
    reason: "native_error",
    message: payload.message || "Apple Calendar operation failed.",
  };
}

function unsupportedFailure<T>(): FeatureResult<T> {
  return {
    ok: false,
    reason: "not_supported",
    platform: detectRuntimePlatform(),
  };
}

function normalizeAttendees(
  attendees: NativeCalendarAttendee[] | undefined,
): LifeOpsCalendarEventAttendee[] {
  return (attendees ?? []).map((attendee) => ({
    email: attendee.email ?? null,
    displayName: attendee.displayName ?? null,
    responseStatus: attendee.responseStatus ?? null,
    self: attendee.self === true,
    organizer: attendee.organizer === true,
    optional: attendee.optional === true,
  }));
}

function normalizeAppleAvailability(
  value: unknown,
): NonNullable<NativeCalendarEvent["availability"]> {
  switch (value) {
    case "not_supported":
    case "busy":
    case "free":
    case "tentative":
    case "unavailable":
      return value;
    default:
      return "unknown";
  }
}

export function lifeOpsCalendarSummaryFromApple(args: {
  calendar: NativeCalendarSummary;
  side?: LifeOpsConnectorSide;
}): LifeOpsCalendarSummary {
  const calendar = args.calendar;
  const calendarId = calendar.calendarId?.trim() || "primary";
  return {
    provider: APPLE_CALENDAR_PROVIDER,
    side: args.side ?? "owner",
    grantId: APPLE_CALENDAR_GRANT_ID,
    connectorAccountId: APPLE_CALENDAR_GRANT_ID,
    accountEmail: null,
    calendarId,
    summary: calendar.summary?.trim() || "Apple Calendar",
    description: calendar.description ?? null,
    primary: calendar.primary === true,
    accessRole: calendar.accessRole ?? "reader",
    backgroundColor: calendar.backgroundColor ?? null,
    foregroundColor: calendar.foregroundColor ?? null,
    timeZone: calendar.timeZone ?? null,
    selected: calendar.selected !== false,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

const APPLE_RECURRENCE_FREQUENCIES: Record<string, string> = {
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
  yearly: "YEARLY",
};

/**
 * Projects EventKit recurrence rules onto RFC 5545 RRULE lines. Rules whose
 * frequency EventKit could not classify are dropped rather than guessed, so a
 * returned array never claims a cadence the provider did not state.
 */
export function appleRecurrenceToRrules(
  rules: NativeCalendarEvent["recurrenceRules"],
): string[] {
  const lines: string[] = [];
  for (const rule of rules ?? []) {
    const frequency = APPLE_RECURRENCE_FREQUENCIES[rule.frequency ?? ""];
    if (!frequency) continue;
    const parts = [`FREQ=${frequency}`];
    const interval = Number.isInteger(rule.interval) ? rule.interval : 1;
    if (interval && interval > 1) parts.push(`INTERVAL=${interval}`);
    if (
      typeof rule.occurrenceCount === "number" &&
      Number.isInteger(rule.occurrenceCount) &&
      rule.occurrenceCount > 0
    ) {
      parts.push(`COUNT=${rule.occurrenceCount}`);
    } else if (rule.endDate) {
      const until = new Date(rule.endDate);
      if (!Number.isNaN(until.getTime())) {
        parts.push(`UNTIL=${until.toISOString().replace(/[-:]|\.\d{3}/g, "")}`);
      }
    }
    lines.push(`RRULE:${parts.join(";")}`);
  }
  return lines;
}

export function lifeOpsCalendarEventFromApple(args: {
  event: NativeCalendarEvent;
  agentId: string;
  side?: LifeOpsConnectorSide;
  syncedAt?: string;
}): LifeOpsCalendarEvent {
  const { event, agentId } = args;
  const side = args.side ?? "owner";
  const syncedAt = args.syncedAt ?? new Date().toISOString();
  const externalId = event.externalId || event.id || "";
  const calendarId = event.calendarId || "primary";
  const startAt = event.startAt || syncedAt;
  const endAt = event.endAt || startAt;
  const availability = normalizeAppleAvailability(event.availability);
  const recurrence = appleRecurrenceToRrules(event.recurrenceRules);
  // EventKit expands a series into occurrences that all share the series'
  // event identifier and recurrence rules (occurrenceDate is set for one-off
  // events too, so it cannot mark a series). Every occurrence therefore
  // carries the series rule and points at the shared identifier.
  const seriesId = event.id?.trim() || externalId;
  const isSeriesOccurrence = recurrence.length > 0 && seriesId.length > 0;
  return {
    id: `${agentId}:apple_calendar:${side}:calendar:${calendarId}:${externalId}`,
    externalId,
    agentId,
    provider: APPLE_CALENDAR_PROVIDER,
    side,
    calendarId,
    title: event.title?.trim() || "(untitled)",
    description: event.description ?? "",
    location: event.location ?? "",
    status:
      availability === "tentative"
        ? "tentative"
        : (event.status ?? "confirmed"),
    startAt,
    endAt,
    isAllDay: event.isAllDay === true,
    timezone: event.timezone ?? null,
    htmlLink: event.htmlLink ?? null,
    conferenceLink: event.conferenceLink ?? null,
    organizer: event.organizer ?? null,
    attendees: normalizeAttendees(event.attendees),
    recurrence: recurrence.length > 0 ? recurrence : null,
    recurringEventId: isSeriesOccurrence ? seriesId : null,
    metadata: {
      appleCalendar: true,
      appleAvailability: availability,
      transparency: availability === "free" ? "transparent" : "opaque",
      iCalUID: event.iCalUID ?? null,
      originalStartTime: event.originalStartAt ?? null,
      appleLastModifiedAt: event.lastModifiedAt ?? null,
      recurrenceRules: event.recurrenceRules ?? [],
      reminders: event.reminders ?? [],
      sourceIdentifier: event.sourceIdentifier ?? null,
      sourceTitle: event.sourceTitle ?? null,
      sourceType: event.sourceType ?? null,
    },
    syncedAt,
    updatedAt: syncedAt,
    calendarSummary: event.calendarSummary,
    connectorAccountId: APPLE_CALENDAR_GRANT_ID,
    grantId: APPLE_CALENDAR_GRANT_ID,
    accountEmail: undefined,
  };
}

export function isAppleCalendarGrant(
  grantId: string | null | undefined,
): boolean {
  return grantId === APPLE_CALENDAR_GRANT_ID;
}

export function isAppleCalendarEvent(
  event: Pick<LifeOpsCalendarEvent, "provider">,
): boolean {
  return event.provider === APPLE_CALENDAR_PROVIDER;
}

export async function listNativeAppleCalendars(args: {
  agentId: string;
  side?: LifeOpsConnectorSide;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<LifeOpsCalendarSummary[]>> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  const payload = await bridge.listCalendars();
  if (!payload.ok) {
    return nativeFailure(payload, args.runtime, "calendar.list");
  }
  return {
    ok: true,
    data: (payload.calendars ?? []).map((calendar) =>
      lifeOpsCalendarSummaryFromApple({
        calendar,
        side: args.side,
      }),
    ),
  };
}

export async function listNativeAppleCalendarEvents(args: {
  agentId: string;
  calendarId?: string | null;
  timeMin: string;
  timeMax: string;
  side?: LifeOpsConnectorSide;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<LifeOpsCalendarEvent[]>> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  const payload = await bridge.listEvents({
    calendarId: args.calendarId,
    timeMin: args.timeMin,
    timeMax: args.timeMax,
  });
  if (!payload.ok) {
    return nativeFailure(payload, args.runtime, "calendar.feed");
  }
  const syncedAt = new Date().toISOString();
  return {
    ok: true,
    data: (payload.events ?? []).map((event) =>
      lifeOpsCalendarEventFromApple({
        event,
        agentId: args.agentId,
        side: args.side,
        syncedAt,
      }),
    ),
  };
}

export async function getNativeAppleCalendarFeed(args: {
  agentId: string;
  calendarId?: string | null;
  timeMin: string;
  timeMax: string;
  side?: LifeOpsConnectorSide;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<LifeOpsCalendarFeed>> {
  const result = await listNativeAppleCalendarEvents(args);
  if (result.ok === false) {
    // FeatureResult failure variants don't reference T; re-typed by widening.
    const failure: FeatureResult<LifeOpsCalendarFeed> = result;
    return failure;
  }
  return {
    ok: true,
    data: {
      calendarId: args.calendarId ?? "all",
      events: result.data,
      source: "synced",
      state: "complete",
      sources: [
        {
          key: {
            provider: APPLE_CALENDAR_PROVIDER,
            side: args.side ?? "owner",
            grantId: APPLE_CALENDAR_GRANT_ID,
            connectorAccountId: APPLE_CALENDAR_GRANT_ID,
            calendarId: args.calendarId ?? "all",
          },
          summary: APPLE_CALENDAR_ACCOUNT_LABEL,
          accessRole: "writer",
          visibility: "details",
          status: "fresh",
          syncedAt: new Date().toISOString(),
          error: null,
        },
      ],
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      syncedAt: new Date().toISOString(),
    },
  };
}

export async function createNativeAppleCalendarEvent(args: {
  agentId: string;
  request: CreateLifeOpsCalendarEventRequest & {
    startAt: string;
    endAt: string;
  };
  side?: LifeOpsConnectorSide;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<NativeAppleCalendarCreateOutcome>> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  const payload = await bridge.createEvent({
    calendarId: args.request.calendarId,
    title: args.request.title.trim(),
    description: args.request.description,
    location: args.request.location,
    startAt: args.request.startAt,
    endAt: args.request.endAt,
    timeZone: args.request.timeZone,
    attendees: args.request.attendees,
  });
  if (!payload.ok) {
    return nativeFailure(payload, args.runtime, "calendar.create");
  }
  if (
    payload.receipt?.accessLevel === "write_only" &&
    payload.receipt.readBackAvailable === false
  ) {
    return {
      ok: true,
      data: {
        kind: "accepted_without_readback",
        receipt: {
          provider: APPLE_CALENDAR_PROVIDER,
          sourceId: APPLE_CALENDAR_GRANT_ID,
          calendarId: args.request.calendarId ?? "primary",
          accessLevel: "write_only",
          destination: "default_calendar",
          providerEventId: null,
          readBackAvailable: false,
          acceptedAt: new Date().toISOString(),
        },
      },
    };
  }
  if (!payload.event) {
    return {
      ok: false,
      reason: "native_error",
      message:
        "Apple Calendar accepted the create without a readable event or a valid write-only receipt.",
    };
  }
  return {
    ok: true,
    data: {
      kind: "event",
      event: lifeOpsCalendarEventFromApple({
        event: payload.event,
        agentId: args.agentId,
        side: args.side,
      }),
    },
  };
}

export async function getNativeAppleCalendarPermissionStatus(): Promise<
  FeatureResult<NativeCalendarPermissionPayload>
> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  return {
    ok: true,
    data: await bridge.checkPermissions(),
  };
}

export async function updateNativeAppleCalendarEvent(args: {
  agentId: string;
  eventId: string;
  request: NativeCalendarEventPayload;
  side?: LifeOpsConnectorSide;
  runtime?: IAgentRuntime | null;
}): Promise<FeatureResult<LifeOpsCalendarEvent>> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  const payload = await bridge.updateEvent(args.eventId, args.request);
  if (!payload.ok || !payload.event) {
    return nativeFailure(payload, args.runtime, "calendar.update");
  }
  return {
    ok: true,
    data: lifeOpsCalendarEventFromApple({
      event: payload.event,
      agentId: args.agentId,
      side: args.side,
    }),
  };
}

export async function deleteNativeAppleCalendarEvent(
  eventId: string,
  options?: { runtime?: IAgentRuntime | null },
): Promise<FeatureResult<{ provider: typeof APPLE_CALENDAR_PROVIDER }>> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  const payload = await bridge.deleteEvent(eventId);
  if (!payload.ok) {
    return nativeFailure(payload, options?.runtime, "calendar.delete");
  }
  return {
    ok: true,
    data: { provider: APPLE_CALENDAR_PROVIDER },
  };
}

export const __testing = {
  setNativeCalendarBridgeForTest(bridge: NativeCalendarBridge | null): void {
    nativeBridgeOverride = bridge;
  },
  setMacCalendarBridgeForTest(bridge: MacCalendarBridge | null): void {
    macCalendarBridgeOverride = bridge;
  },
  nativeDylibCandidates,
};
