/** The server admits every Notes/Calendar review the phone offers, and no exact-target review without a phone selection. */
import { NOTES_LIST_FILTER_CAPABILITY } from "@elizaos/contracts";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DeviceContextEnvelope,
  proposalContextNotice,
} from "./client-coordinator.ts";
import {
  currentAppRecordSource,
  DEVICE_RECORD_ADMISSION,
  DeviceActionService,
  deviceAppRecordOperationAvailable,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";

const agentId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const timeZone = "America/Los_Angeles";
const revision = "a".repeat(64);
const ALL = [
  "notes.local-record.v1",
  "notes.query.v1",
  "notes.search.v1",
  "device.named-target.v1",
  "calendar.local-event.v1",
  "calendar.availability-read.v1",
  "calendar.named-read.v1",
  "calendar.create.v1",
  "calendar.next-read.v1",
];
const VIEWS = [
  "home",
  "notes",
  "calendar",
  "maps",
  "messages",
  "camera",
  "photos",
  "chat",
];
const SAMPLES: Record<string, Record<string, unknown>> = {
  notes_query: { type: "notes_query", query: { kind: "title", text: "Trip" } },
  notes_search: {
    type: "notes_search",
    query: { kind: "content", text: "passport" },
  },
  notes_named: { type: "notes_named", action: "delete", name: "Trip" },
  calendar_availability: {
    type: "calendar_availability",
    start: "2026-11-09T15:00:00-08:00",
    end: "2026-11-09T16:00:00-08:00",
    timeZone,
  },
  calendar_named: { type: "calendar_named", action: "delete", name: "Lunch" },
  calendar_read_next: { type: "calendar_read_next" },
  calendar_create_local: { type: "calendar_create_local" },
};
const note = {
  kind: "note",
  id: "note-1",
  revision,
  accountId: "notes-source",
  sourceRevision: revision,
};

afterEach(() => vi.restoreAllMocks());

/** Admission for each type inside one authenticated owner turn on this screen. */
async function admitted(
  context: Record<string, unknown>,
  types: readonly string[],
  capabilities: string[] = ALL,
) {
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
      text: "Synthetic request.",
      metadata: { clientDevice: { context: { revision: 1, ...context } } },
    },
  } as Memory;
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  return withDeviceActionTurn(
    runtime,
    {
      subjectUserId: "owner-subject",
      installationId: "installation",
      deviceKey: "key",
      capabilities,
    },
    async () => {
      setDeviceActionRequestMessage(runtime, message);
      return {
        calendar: currentAppRecordSource(runtime, "calendar", message),
        admitted: Object.fromEntries(
          types.map((type) => [
            type,
            deviceAppRecordOperationAvailable(runtime, { type }, message),
          ]),
        ),
      };
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
}

describe("device Notes/Calendar admission", () => {
  it("admits canonical Notes filtering only from the authenticated live list", async () => {
    const type = "notes_list_filter",
      caps = [NOTES_LIST_FILTER_CAPABILITY];
    const selectedObject = {
      kind: "canonical-note-source",
      id: "notes",
      revision: "12",
    };
    const list = { view: "notes", sensitive: false, selectedObject };
    expect((await admitted(list, [type], caps)).admitted[type]).toBe(true);
    for (const context of [
      { ...list, view: "home" },
      { ...list, sensitive: true },
      { ...list, selectedObject: undefined },
      { ...list, selectedObject: note },
      {
        ...list,
        selectedObject: { ...selectedObject, kind: "canonical-note" },
      },
      { ...list, selectedObject: { ...selectedObject, revision: "old" } },
    ])
      expect((await admitted(context, [type], caps)).admitted[type]).toBe(
        false,
      );
    expect(
      (
        await admitted(
          list,
          [type],
          ["notes.organize.v1", "notes.local-record.v1"],
        )
      ).admitted[type],
    ).toBe(false);
  });
  it("admits every no-selection review the phone accepts on that screen", async () => {
    const ports = {
      namedCalendarReadTarget: () => ({ id: "event" }),
      foregroundHidden: () => false,
      mapsSelectionCurrent: () => true,
    };
    for (const view of VIEWS) {
      const context = { view, sensitive: false, timeZone };
      const phone = Object.keys(SAMPLES).filter(
        (type) =>
          proposalContextNotice(
            SAMPLES[type] as never,
            { ...context, revision: 1 } as DeviceContextEnvelope,
            ports,
          ) === undefined,
      );
      // Home offers every one of these reviews on the phone.
      if (view === "home") expect(phone).toEqual(Object.keys(SAMPLES));
      const server = await admitted(context, Object.keys(SAMPLES));
      for (const type of phone)
        expect([view, type, server.admitted[type]]).toEqual([view, type, true]);
    }
  });

  it.each([
    "notes_query",
    "notes_named",
    "calendar_named",
    "calendar_availability",
    "calendar_read_next",
    "calendar_create_local",
  ])("admits %s from Home with no selection", async (type) => {
    expect(
      (await admitted({ view: "home", sensitive: false, timeZone }, [type]))
        .admitted[type],
    ).toBe(true);
  });

  it("keeps Home reviews closed without their capability, with a canonical selection, or on a private screen", async () => {
    const types = Object.keys(SAMPLES);
    const none = await admitted(
      { view: "home", sensitive: false, timeZone },
      types,
      [],
    );
    expect(Object.values(none.admitted)).not.toContain(true);
    const canonical = await admitted(
      {
        view: "calendar",
        sensitive: false,
        timeZone,
        selectedObject: { kind: "canonical-calendar-event", id: "event-1" },
      },
      ["calendar_read_next", "calendar_availability"],
    );
    expect(canonical.admitted).toEqual({
      calendar_read_next: false,
      calendar_availability: false,
    });
    const locked = await admitted(
      { view: "home", sensitive: true, timeZone },
      types,
    );
    expect(Object.values(locked.admitted)).not.toContain(true);
  });

  it("still requires a phone selection for exact-target operations", async () => {
    const exact = Object.entries(DEVICE_RECORD_ADMISSION)
      .filter(([, rule]) => rule.selection === "device")
      .map(([type]) => type);
    for (const view of ["home", "notes", "calendar"]) {
      const result = await admitted(
        { view, sensitive: false, timeZone },
        exact,
      );
      expect(Object.values(result.admitted)).not.toContain(true);
    }
    const selected = await admitted(
      { view: "notes", sensitive: false, timeZone, selectedObject: note },
      ["notes_update", "notes_read_selected", "calendar_update"],
    );
    expect(selected.admitted).toEqual({
      notes_update: true,
      notes_read_selected: true,
      calendar_update: false,
    });
  });

  it.each([
    { kind: "reminder", id: "reminder-1" },
    { kind: "clock-draft", id: "clock-1" },
  ])(
    "treats a $kind selection in Calendar as no Calendar selection",
    async (selectedObject) => {
      const result = await admitted(
        { view: "calendar", sensitive: false, timeZone, selectedObject },
        ["calendar_availability", "calendar_update"],
      );
      expect(result.calendar).toBe("runtime");
      expect(result.admitted).toEqual({
        calendar_availability: true,
        calendar_update: false,
      });
    },
  );

  it("keeps a malformed Calendar selection unavailable", async () => {
    const result = await admitted(
      {
        view: "calendar",
        sensitive: false,
        timeZone,
        selectedObject: { kind: "calendar-event", id: "event-1" },
      },
      ["calendar_availability"],
    );
    expect(result).toEqual({
      calendar: "unavailable",
      admitted: { calendar_availability: false },
    });
  });
});
