import { beforeEach, expect, it, vi } from "vitest";
import type { ScenarioContext } from "../schema/index.ts";
import { applyScenarioSeedStep } from "./seeds.ts";

const writes = vi.hoisted(() => ({
  task: vi.fn(),
  attempt: vi.fn(),
  event: vi.fn(),
}));
vi.mock("@elizaos/plugin-personal-assistant/lifeops/index", () => ({
  LifeOpsRepository: class {
    static bootstrapSchema = vi.fn();
    upsertScheduledTask = writes.task;
    createReminderAttempt = writes.attempt;
    upsertCalendarEvent = writes.event;
    async listCalendarEvents() {
      return [{ id: "meeting", startAt: "2026-10-04T12:00:00Z" }];
    }
  },
}));
const context: ScenarioContext = {
  runtime: { agentId: "agent", createMemory: vi.fn() },
  actionsCalled: [],
  scenarioId: "seed-contracts",
  now: "2026-10-04T10:00:00Z",
  primaryRoomId: "room",
  primaryUserId: "owner",
};
beforeEach(() => vi.clearAllMocks());

it("maps legacy push channels to valid reminder channels without losing provider evidence", async () => {
  await expect(
    applyScenarioSeedStep(context, {
      type: "memory",
      content: {
        kind: "push-delivery-attempt",
        channel: "ntfy",
        topic: "meeting",
        result: "failed",
        statusCode: 503,
      },
    }),
  ).resolves.toBeUndefined();
  expect(writes.attempt).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "push",
      outcome: "blocked_connector",
      connectorRef: "ntfy:meeting",
      deliveryMetadata: expect.objectContaining({
        channel: "ntfy",
        title: "ntfy push",
        statusCode: 503,
      }),
    }),
  );
  await expect(
    applyScenarioSeedStep(context, {
      type: "memory",
      content: { kind: "push-delivery-attempt", channel: "unsupported" },
    }),
  ).rejects.toMatchObject({ code: "SCENARIO_SEED_INVALID_CHANNEL" });
  expect(writes.attempt).toHaveBeenCalledTimes(1);
});

it("uses scheduler vocabulary for cancelled ladders and owner followups", async () => {
  await expect(
    applyScenarioSeedStep(context, {
      type: "memory",
      content: {
        kind: "scheduled-push-ladder",
        eventId: "meeting",
        rungs: [{ channel: "desktop", status: "cancelled" }],
      },
    }),
  ).resolves.toBeUndefined();
  expect(writes.task).toHaveBeenLastCalledWith(
    "agent",
    expect.objectContaining({
      source: "plugin",
      state: { status: "dismissed", followupCount: 0 },
      subject: { kind: "calendar_event", id: "meeting" },
      metadata: expect.objectContaining({
        rung: expect.objectContaining({
          channel: "desktop",
          deliveryChannel: "push",
          status: "cancelled",
        }),
      }),
    }),
    expect.anything(),
  );
  await expect(
    applyScenarioSeedStep(context, {
      type: "memory",
      content: { kind: "open-decision", topic: "Lunch" },
    }),
  ).resolves.toBeUndefined();
  expect(writes.task).toHaveBeenLastCalledWith(
    "agent",
    expect.objectContaining({
      kind: "approval",
      source: "plugin",
      subject: { kind: "self", id: "agent" },
    }),
    expect.anything(),
  );
});

it("normalizes partial calendar attendees and rejects malformed evidence before writing", async () => {
  const content = {
    kind: "calendar-event",
    title: "Meeting",
    startAt: "2026-10-04T12:00:00Z",
    attendees: [{ email: "owner@example.test", optional: true }],
  };
  await expect(
    applyScenarioSeedStep(context, { type: "memory", content }),
  ).resolves.toBeUndefined();
  expect(writes.event).toHaveBeenCalledWith(
    expect.objectContaining({
      attendees: [
        {
          email: "owner@example.test",
          displayName: null,
          responseStatus: null,
          self: false,
          organizer: false,
          optional: true,
        },
      ],
    }),
    "owner",
  );
  await expect(
    applyScenarioSeedStep(context, {
      type: "memory",
      content: { ...content, attendees: [{ email: 42 }] },
    }),
  ).rejects.toMatchObject({ code: "SCENARIO_SEED_INVALID_ATTENDEES" });
  expect(writes.event).toHaveBeenCalledTimes(1);
});
