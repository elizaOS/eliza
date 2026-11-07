import { expect, test } from "bun:test";
import { LifeOpsRepository } from "@elizaos/plugin-personal-assistant/lifeops/index";
import { applyScenarioSeedStep } from "../scenario-runner/src/seeds.ts";
import { createTestRuntime } from "../src/pglite-runtime.ts";

test("scenario seeds use production task, reminder and calendar contracts without losing authored data", async () => {
  const fixture = await createTestRuntime({
    settings: { ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false },
  });
  const { runtime } = fixture;
  const ctx = {
    runtime,
    actionsCalled: [],
    scenarioId: "owner-contract",
    now: "2026-10-04T10:00:00.000Z",
  };
  try {
    const seed = (content: Record<string, unknown>) =>
      applyScenarioSeedStep(ctx, { type: "memory", content });
    expect(
      await seed({
        kind: "outbound-push-attempt",
        title: "ntfy receipt",
        channel: "ntfy",
        topic: "owned-topic",
        readAt: null,
      }),
    ).toBeUndefined();
    const repository = new LifeOpsRepository(runtime);
    const attempts = await repository.listReminderAttempts(
      String(runtime.agentId),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      channel: "push",
      connectorRef: "ntfy:owned-topic",
      outcome: "delivered_unread",
      deliveryMetadata: { channel: "ntfy" },
    });
    await expect(
      seed({ kind: "outbound-push-attempt", channel: "unsupported" }),
    ).rejects.toMatchObject({ code: "SCENARIO_SEED_INVALID_CHANNEL" });
    const attendee = {
      email: "guest@example.invalid",
      displayName: "  Guest  ",
      authoredEvidence: "complete",
    };
    expect(
      await seed({
        kind: "calendar-event",
        id: "fixture-event",
        title: "Seeded event",
        startAt: "2026-10-04T11:00:00.000Z",
        attendees: [attendee],
      }),
    ).toBeUndefined();
    const events = await repository.listCalendarEvents(
      String(runtime.agentId),
      "google",
      undefined,
      undefined,
      "owner",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.attendees).toMatchObject([
      { email: attendee.email, self: false, organizer: false, optional: false },
    ]);
    expect(events[0]?.metadata.authoredAttendees).toEqual([attendee]);
    for (const malformed of [{ email: 42 }, { self: "true" }]) {
      await expect(
        seed({
          kind: "calendar-event",
          title: "Malformed",
          startAt: "2026-10-04T12:00:00.000Z",
          attendees: [malformed],
        }),
      ).rejects.toMatchObject({ code: "SCENARIO_SEED_INVALID_ATTENDEES" });
    }
    expect(
      await repository.listCalendarEvents(
        String(runtime.agentId),
        "google",
        undefined,
        undefined,
        "owner",
      ),
    ).toHaveLength(1);

    expect(
      await seed({
        kind: "scheduled-push-ladder",
        eventId: "fixture-event",
        rungs: [{ channel: "ntfy", status: "cancelled" }],
      }),
    ).toBeUndefined();
    const tasks = await repository.listScheduledTasks(String(runtime.agentId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      source: "plugin",
      subject: { kind: "calendar_event", id: "fixture-event" },
      state: { status: "dismissed" },
      metadata: { rung: { status: "cancelled", channel: "ntfy" } },
    });
  } finally {
    await fixture.cleanup();
  }
}, 180_000);
