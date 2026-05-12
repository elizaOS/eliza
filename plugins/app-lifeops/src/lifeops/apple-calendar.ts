/// <reference types="bun-types" />
import { existsSync } from "node:fs";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { FeatureResult, IPermissionsRegistry } from "@elizaos/shared";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventAttendee,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsConnectorSide,
} from "../contracts/index.js";

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
  startAt?: string;
  endAt?: string;
  isAllDay?: boolean;
  timezone?: string | null;
  htmlLink?: string | null;
  conferenceLink?: string | null;
  organizer?: Record<string, unknown> | null;
  attendees?: NativeCalendarAttendee[];
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
};

type NativeCalendarPayload = {
  ok: boolean;
  error?: string;
  message?: string;
  calendars?: NativeCalendarSummary[];
  events?: NativeCalendarEvent[];
  event?: NativeCalendarEvent;
};

type NativeCalendarBridge = {
  platform: string;
  listCalendars(): Promise<NativeCalendarPayload>;
  listEvents(args: {
    calendarId?: string | null;
    timeMin: string;
    timeMax: string;
  }): Promise<NativeCalendarPayload>;
  createEvent(
    payload: NativeCalendarEventPayload,
  ): Promise<NativeCalendarPayload>;
  updateEvent(
    eventId: string,
    payload: NativeCalendarEventPayload,
  ): Promise<NativeCalendarPayload>;
  deleteEvent(eventId: string): Promise<NativeCalendarPayload>;
};

type NativeCalendarEventPayload = {
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  isAllDay?: boolean;
  attendees?: CreateLifeOpsCalendarEventAttendee[];
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

const NATIVE_DYLIB_ENV =
  typeof process !== "undefined"
    ? (process.env.ELIZA_NATIVE_PERMISSIONS_DYLIB ?? "")
    : "";

const NATIVE_DYLIB_CANDIDATES = [
  NATIVE_DYLIB_ENV,
  "../../../../packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib",
].filter(Boolean);

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

  for (const candidate of NATIVE_DYLIB_CANDIDATES) {
    const dylibPath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(import.meta.dir, candidate);
    if (!existsSync(dylibPath)) continue;
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
    } catch {
      // Try the next dylib candidate.
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
  };
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
    const { AppleCalendar } = await import("@elizaos/capacitor-calendar");
    return {
      platform: "ios",
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
    };
  } catch {
    return null;
  }
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
  if (!service) return null;
  return service as unknown as IPermissionsRegistry;
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
  };
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
    status: event.status ?? "confirmed",
    startAt,
    endAt,
    isAllDay: event.isAllDay === true,
    timezone: event.timezone ?? null,
    htmlLink: event.htmlLink ?? null,
    conferenceLink: event.conferenceLink ?? null,
    organizer: event.organizer ?? null,
    attendees: normalizeAttendees(event.attendees),
    metadata: {
      appleCalendar: true,
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
}): Promise<FeatureResult<LifeOpsCalendarEvent>> {
  const bridge = await loadNativeCalendarBridge();
  if (!bridge) return unsupportedFailure();
  const payload = await bridge.createEvent({
    calendarId: args.request.calendarId,
    title: args.request.title,
    description: args.request.description,
    location: args.request.location,
    startAt: args.request.startAt,
    endAt: args.request.endAt,
    timeZone: args.request.timeZone,
    attendees: args.request.attendees,
  });
  if (!payload.ok || !payload.event) {
    return nativeFailure(payload, args.runtime, "calendar.create");
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
};
