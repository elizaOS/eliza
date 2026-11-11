import { createHash } from "node:crypto";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { calendarReadBindingField } from "../read-binding.js";
import {
  calendarReadSelectedAction,
  selectedCalendarTarget,
} from "./calendar-read-selected.js";

function fixture(provider: "eliza" | "google" = "eliza") {
  const agent = "11111111-1111-4111-8111-111111111111";
  const source = {
    provider,
    side: "owner",
    grantId: "eliza-calendar",
    connectorAccountId: "local-owner",
    calendarId: "primary",
    accessRole: "owner",
  };
  const event = {
    id: "selected-event",
    agentId: agent,
    ...source,
    title: "Selected QA",
    accountEmail: "selected-owner@example.test",
    calendarSummary: "Selected owner calendar",
    description: `${"Complete selected event detail.\n".repeat(4096)}FINAL_SELECTED_DETAIL`,
    startAt: "2026-11-02T23:00:00Z",
    endAt: "2026-11-02T23:05:00Z",
    timezone: "America/Los_Angeles",
    isAllDay: false,
    metadata: { etag: '"v1"' },
    status: "confirmed",
  };
  const target = {
    kind: "canonical-calendar-event",
    id: event.id,
    revision: '"v1"',
    accountId: source.grantId,
    sourceRevision: createHash("sha256")
      .update(
        JSON.stringify([
          source.provider,
          source.side,
          source.grantId,
          source.connectorAccountId,
          source.calendarId,
        ]),
      )
      .digest("hex"),
  };
  const context = {
    view: "calendar",
    revision: 1,
    sensitive: false,
    selectedObject: target,
  };
  const message = {
    id: "22222222-2222-4222-8222-222222222222",
    entityId: agent,
    roomId: "33333333-3333-4333-8333-333333333333",
    createdAt: Date.now(),
    content: {
      text: "Read the event open on my screen",
      metadata: { clientDevice: { context } },
    },
  } as Memory;
  const snapshot = {
    feed: {
      state: "complete",
      events: [event],
      sources: [{ status: "fresh", summary: "UNSELECTED_SOURCE_SENTINEL" }],
    },
    calendars: [source],
  };
  const service = {
    getCalendarEventById: vi.fn(async () => event),
    getCalendarFeedSnapshot: vi.fn(
      async (_url: unknown, _options: { timeMin: string; timeMax: string }) =>
        snapshot,
    ),
  };
  const runtime = {
    agentId: agent,
    getService: () => service,
    getSetting: () => undefined,
    getRoom: async () => null,
    reportError() {},
  } as unknown as IAgentRuntime;
  return {
    runtime,
    message,
    source,
    event,
    target,
    context,
    snapshot,
    service,
  };
}

const run = (f: ReturnType<typeof fixture>) => {
  const handler = calendarReadSelectedAction.handler;
  if (!handler) throw Error("Missing selected Calendar handler");
  return handler(f.runtime, f.message);
};

describe("current selected canonical Calendar read", () => {
  it("reads a selected Google event through second-precision filters and emits its versioned receipt", async () => {
    const f = fixture("google");
    const neighbor = {
      ...f.event,
      id: "neighbor-event",
      title: "Another event",
    };
    // Google ignores fractional seconds and excludes events starting at timeMax.
    f.service.getCalendarFeedSnapshot.mockImplementation(
      async (_url, query) => {
        const timeMin = Math.floor(Date.parse(query.timeMin) / 1000) * 1000;
        const timeMax = Math.floor(Date.parse(query.timeMax) / 1000) * 1000;
        return {
          ...f.snapshot,
          feed: {
            ...f.snapshot.feed,
            events: [f.event, neighbor].filter(
              (event) =>
                Date.parse(event.startAt) < timeMax &&
                Date.parse(event.endAt) > timeMin,
            ),
          },
        };
      },
    );
    const result = await run(f);
    expect(result).toMatchObject({ data: { event: f.event } });
    expect(JSON.stringify(result.data)).not.toContain(
      "UNSELECTED_SOURCE_SENTINEL",
    );
    expect(result.promptData?.event).toMatchObject({
      ...f.event,
      displayDate: "Monday, November 2, 2026",
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        event: f.event,
        selectionProof: {
          id: f.target.id,
          revision: f.target.revision,
          sourceMessageId: f.message.id,
        },
      },
      effectReceipts: [
        {
          operation: "calendar.event.selected.read",
          outcome: "noop",
          resource: { id: f.event.id, version: f.target.revision },
        },
      ],
    });
    expect(f.service.getCalendarFeedSnapshot.mock.calls[0]?.[1]).toMatchObject({
      grantId: f.source.grantId,
      calendarId: f.source.calendarId,
      forceSync: true,
      timeMin: "2026-11-02T22:59:59.000Z",
      timeMax: "2026-11-02T23:00:01.000Z",
    });
  });
  it("refuses a selection replaced while its authorized feed read is pending", async () => {
    const f = fixture("google");
    let entered!: () => void;
    const querying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (snapshot: typeof f.snapshot) => void;
    f.service.getCalendarFeedSnapshot.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const reading = run(f);
    await querying;
    f.target.id = "replacement-event";
    release(f.snapshot);
    await expect(reading).rejects.toMatchObject({
      code: "CALENDAR_SELECTED_RECORD_UNAVAILABLE",
    });
  });
  it("supplies the computed weekday for an all-day selected event", async () => {
    const f = fixture("google");
    Object.assign(f.event, {
      startAt: "2026-11-11T00:00:00Z",
      endAt: "2026-11-12T00:00:00Z",
      isAllDay: true,
      timezone: "UTC",
    });
    Object.assign(f.context, { timeZone: "America/Los_Angeles" });
    const result = await run(f);
    expect(result.promptData?.event).toMatchObject({
      displayDate: "Wednesday, November 11, 2026",
      displayTime: expect.stringMatching(/^Nov 11(, 2026)?, all day$/),
      startAt: f.event.startAt,
      endAt: f.event.endAt,
    });
    expect(result.promptData?.event).toHaveProperty(
      "accountEmail",
      f.event.accountEmail,
    );
  });
  it.each([
    [
      "America/Los_Angeles",
      "2026-11-11T00:00:00Z",
      "Tuesday, November 10, 2026",
    ],
    [
      "Pacific/Kiritimati",
      "2026-11-11T23:00:00Z",
      "Thursday, November 12, 2026",
    ],
    ["UTC", "2026-11-11T00:00:00Z", "Wednesday, November 11, 2026"],
  ])(
    "keeps the whole timed selected event and computes its date in %s",
    async (timeZone, startAt, displayDate) => {
      const f = fixture("google");
      Object.assign(f.context, { timeZone });
      Object.assign(f.event, {
        startAt,
        endAt: new Date(Date.parse(startAt) + 60000).toISOString(),
      });
      const result = await run(f);
      expect(result.data?.event).toEqual(f.event);
      expect(result.promptData?.event).toMatchObject({
        ...f.event,
        displayDate,
      });
      expect(result.promptData?.event).toHaveProperty(
        "description",
        f.event.description,
      );
      expect(result.effectReceipts).toMatchObject([
        { resource: { id: f.target.id, version: f.target.revision } },
      ]);
    },
  );

  it("preserves the all-day civil date when its canonical timestamp has an offset", async () => {
    const f = fixture("google");
    Object.assign(f.context, { timeZone: "America/Los_Angeles" });
    Object.assign(f.event, {
      startAt: "2026-11-11T00:00:00+14:00",
      endAt: "2026-11-12T00:00:00+14:00",
      isAllDay: true,
    });
    const result = await run(f);
    expect(result.promptData?.event).toMatchObject({
      ...f.event,
      displayDate: "Wednesday, November 11, 2026",
      displayTime: expect.stringMatching(/^Nov 11(, 2026)?, all day$/),
    });
  });
  it.each([
    "wrong-owner",
    "wrong-view",
    "sensitive",
    "native-selection",
    "stale-revision",
    "wrong-source",
    "revoked-source",
    "partial-feed",
    "missing-event",
    "changed-event",
    "duplicate-event",
  ])("refuses %s without returning record evidence", async (kind) => {
    const f = fixture();
    if (kind === "wrong-owner")
      f.message.entityId = "44444444-4444-4444-8444-444444444444";
    if (kind === "wrong-view") f.context.view = "notes";
    if (kind === "sensitive") f.context.sensitive = true;
    if (kind === "native-selection") f.target.kind = "calendar-event";
    if (kind === "stale-revision") f.target.revision = '"old"';
    if (kind === "wrong-source") f.target.sourceRevision = "b".repeat(64);
    if (kind === "revoked-source") f.source.accessRole = "none";
    if (kind === "partial-feed") f.snapshot.feed.state = "partial";
    if (kind === "missing-event") f.snapshot.feed.events = [];
    if (kind === "changed-event")
      f.snapshot.feed.events = [{ ...f.event, metadata: { etag: '"new"' } }];
    if (kind === "duplicate-event") f.snapshot.feed.events.push(f.event);
    await expect(run(f)).rejects.toMatchObject({
      code: "CALENDAR_SELECTED_RECORD_UNAVAILABLE",
    });
  });
  it("binds only the host's current target and refuses a model-supplied target", () => {
    const f = fixture(),
      raw = {
        intentId: "intent:1",
        operation: "read_selected",
        execution: "required",
        purpose: "requested_read",
        filterEvidence: [],
      };
    const ctx = { message: f.message, runtime: f.runtime } as Parameters<
      NonNullable<typeof calendarReadBindingField.parse>
    >[1];
    expect(calendarReadBindingField.parse?.([raw], ctx)).toMatchObject([
      { selectedTarget: selectedCalendarTarget(f.message) },
    ]);
    expect(
      calendarReadBindingField.parse?.(
        [{ ...raw, selectedTarget: { id: "injected" } }],
        ctx,
      ),
    ).toBeNull();
    f.context.view = "notes";
    expect(calendarReadBindingField.parse?.([raw], ctx)).toBeNull();
  });
});
