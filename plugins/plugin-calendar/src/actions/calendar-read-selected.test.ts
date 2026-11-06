import { createHash } from "node:crypto";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { calendarReadBindingField } from "../read-binding.js";
import {
  calendarReadSelectedAction,
  selectedCalendarTarget,
} from "./calendar-read-selected.js";

function fixture() {
  const agent = "11111111-1111-4111-8111-111111111111";
  const source = {
    provider: "eliza",
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
    startAt: "2026-11-02T23:00:00Z",
    endAt: "2026-11-02T23:05:00Z",
    timezone: "America/Los_Angeles",
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
    feed: { state: "complete", events: [event] },
    calendars: [source],
  };
  const service = {
    getCalendarEventById: vi.fn(async () => event),
    getCalendarFeedSnapshot: vi.fn(async () => snapshot),
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
  it("reads a fresh exact selected record through the authorized source and emits its versioned receipt", async () => {
    const f = fixture(),
      result = await run(f);
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
      timeMin: "2026-11-02T22:59:59.999Z",
      timeMax: "2026-11-02T23:00:00.001Z",
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
