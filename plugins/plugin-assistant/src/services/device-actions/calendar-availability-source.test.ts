/** Native bridge presence cannot take ownership of canonical runtime Calendar availability. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConflictDetectAction } from "../../../../plugin-calendar/src/actions/conflict-detect.ts";
import { CALENDAR_CREATE_CAPABILITY } from "./calendar-contract.ts";
import {
  currentAppRecordSource,
  DeviceActionService,
  requestLocalCalendarAvailability,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";

const agentId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const proposal = {
  startISO: "2026-10-28T16:30:00-07:00",
  endISO: "2026-10-28T16:45:00-07:00",
};
const nativeSource = {
  kind: "calendar-source",
  id: "native-calendar",
  revision: "a".repeat(64),
};
afterEach(() => vi.restoreAllMocks());
async function scan(
  options: {
    selected?: unknown;
    status?: "fresh" | "stale";
    busy?: boolean;
    current?: boolean;
    capabilities?: string[];
    wrongOwner?: boolean;
  } = {},
) {
  const loadFeed = vi.fn(async () => ({
    calendarId: "primary",
    source: "synced",
    state: "complete",
    syncedAt: "2026-10-27T09:17:43.714Z",
    events: options.busy
      ? [
          {
            id: "busy-event",
            provider: "eliza",
            side: "owner",
            grantId: "eliza-calendar",
            connectorAccountId: "eliza-calendar",
            calendarId: "primary",
            title: "Existing commitment",
            startAt: "2026-10-28T23:30:00.000Z",
            endAt: "2026-10-28T23:45:00.000Z",
            timezone: "America/Los_Angeles",
            isAllDay: false,
            status: "confirmed",
            attendees: [],
            metadata: {},
          },
        ]
      : [],
    sources: [
      {
        key: {
          provider: "eliza",
          side: "owner",
          grantId: "eliza-calendar",
          connectorAccountId: "eliza-calendar",
          calendarId: "primary",
        },
        status: options.status ?? "fresh",
        visibility: "details",
        summary: "Eliza Calendar",
        error: null,
      },
    ],
  }));
  const runtime = {
    agentId,
    getSetting: () => undefined,
    actions: [],
    getService: (name: string) =>
      name === "calendar" ? { getCalendarFeed: loadFeed } : null,
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId,
    entityId: owner,
    roomId: "55555555-5555-4555-8555-555555555555",
    content: {
      text: "Move launch review to 4:30 pm.",
      metadata: {
        clientDevice: {
          context: {
            view: options.selected ? "calendar" : "chat",
            sensitive: false,
            timeZone: "America/Los_Angeles",
            revision: 1,
            ...(options.selected ? { selectedObject: options.selected } : {}),
          },
        },
      },
    },
  } as Memory;
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  const credential = {
    subjectUserId: "owner-subject",
    installationId: "installation",
    deviceKey: "key",
    capabilities: options.capabilities ?? [CALENDAR_CREATE_CAPABILITY],
  };
  const action = createConflictDetectAction({
    authorize: async () => true,
    requestLocalAvailability: requestLocalCalendarAvailability,
  });
  let current = true;
  let source: ReturnType<typeof currentAppRecordSource> | undefined;
  const result = await withDeviceActionTurn(
    runtime,
    credential,
    async () => {
      setDeviceActionRequestMessage(runtime, message);
      if (options.current === false) current = false;
      if (options.wrongOwner)
        message.entityId = "44444444-4444-4444-8444-444444444444";
      source = currentAppRecordSource(runtime, "calendar", message);
      return action.handler(runtime, message, undefined, {
        parameters: {
          subaction: "scan_event_proposal",
          proposal,
          timeZone: "America/Los_Angeles",
        },
      });
    },
    {
      isCurrent: () => current,
      requestCaller: {
        subjectUserId: "owner-subject",
        entityId: owner,
        role: "OWNER",
      },
    },
  );
  return { source, result, loadFeed };
}

describe("Calendar availability source ownership", () => {
  it.each([
    undefined,
    { kind: "canonical-calendar-event", id: "canonical-event" },
  ])(
    "uses canonical feed with native capability but runtime-owned selection %j",
    async (selected) => {
      const { source, result, loadFeed } = await scan({ selected });
      expect(source).toBe("runtime");
      expect(loadFeed).toHaveBeenCalledTimes(1);
      expect(result?.success).toBe(true);
      expect(result?.data).toMatchObject({ definitive: true, conflicts: [] });
    },
  );
  it("still evaluates a real overlapping commitment using the canonical engine", async () => {
    const { result, loadFeed } = await scan({ busy: true });
    expect(loadFeed).toHaveBeenCalledTimes(1);
    expect(result?.data).toMatchObject({ definitive: true });
    expect(result?.data?.conflicts).toHaveLength(1);
  });
  it("keeps stale canonical source health visibly non-definitive", async () => {
    const { result, loadFeed } = await scan({ status: "stale" });
    expect(loadFeed).toHaveBeenCalledTimes(1);
    expect(result?.data).toMatchObject({ definitive: false });
  });
  it.each([
    {
      label: "explicit native source without agenda permission",
      selected: nativeSource,
    },
    {
      label: "explicit native source without any capability",
      selected: nativeSource,
      capabilities: [],
    },
    {
      label: "malformed native source",
      selected: { ...nativeSource, revision: "invalid" },
    },
    { label: "expired turn", current: false },
    { label: "different caller", wrongOwner: true },
  ])("does not fall through to another store for $label", async (options) => {
    const { result, loadFeed } = await scan(options);
    expect(loadFeed).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      code: "LOCAL_CALENDAR_AVAILABILITY_UNAVAILABLE",
      definitive: false,
    });
  });
});

describe("Clock host device context", () => {
  // The Android Clock host's chat bridge sends these two shapes as
  // clientDevice.context: no view, so no screen observation, and never private.
  it.each([
    { sensitive: false, revision: 4, timeZone: "America/Los_Angeles" },
    {
      sensitive: false,
      revision: 4,
      timeZone: "America/Los_Angeles",
      alarmsStatus: "available",
      alarmsObservedAt: 1_761_600_000_000,
      alarmsRevision: "alarms-1",
      alarms: [],
    },
  ])("keeps canonical Notes and Calendar routing for %j", async (context) => {
    const runtime = {
      agentId,
      getSetting: () => undefined,
      actions: [],
      getService: () => null,
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as unknown as IAgentRuntime;
    const message = {
      id: "33333333-3333-4333-8333-333333333333",
      agentId,
      entityId: owner,
      roomId: "55555555-5555-4555-8555-555555555555",
      content: {
        text: "What is on my calendar tomorrow?",
        metadata: { clientDevice: { context } },
      },
    } as Memory;
    vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
      null,
    );
    const sources = await withDeviceActionTurn(
      runtime,
      {
        subjectUserId: "owner-subject",
        installationId: "installation",
        deviceKey: "key",
        capabilities: [CALENDAR_CREATE_CAPABILITY],
      },
      async () => {
        setDeviceActionRequestMessage(runtime, message);
        return [
          currentAppRecordSource(runtime, "notes", message),
          currentAppRecordSource(runtime, "calendar", message),
        ];
      },
      {
        isCurrent: () => true,
        requestCaller: {
          subjectUserId: "owner-subject",
          entityId: owner,
          role: "OWNER",
        },
      },
    );
    expect(sources).toEqual(["runtime", "runtime"]);
  });
});
