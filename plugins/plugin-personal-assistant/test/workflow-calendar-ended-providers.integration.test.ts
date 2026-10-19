/**
 * A "calendar event ended" workflow runs for meetings from every connected
 * calendar, not only Google, and runs once for a meeting that two connected
 * calendars both store (same iCalUID).
 */
import { TaskService } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

const T0 = Date.parse("2026-10-13T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

it("runs for an Outlook meeting and once for a meeting in both Google and Outlook", async () => {
  const f = await createLifeOpsTestRuntime();
  await TaskService.stop(f.runtime);
  await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(f.runtime);
  vi.spyOn(f.runtime, "useModel").mockRejectedValue(
    new Error("No inference expected"),
  );
  try {
    const service = new LifeOpsService(f.runtime);
    const repository = new LifeOpsRepository(f.runtime);
    const storeEndedEvent = (
      id: string,
      provider: string,
      endMs: number,
      metadata: Record<string, unknown>,
    ) =>
      repository.upsertCalendarEvent({
        id,
        externalId: `external-${id}`,
        agentId: f.runtime.agentId,
        provider,
        side: "owner",
        calendarId: "primary",
        title: `Meeting ${id}`,
        description: "",
        location: "",
        status: "confirmed",
        startAt: new Date(endMs - 30 * 60_000).toISOString(),
        endAt: new Date(endMs).toISOString(),
        isAllDay: false,
        timezone: "UTC",
        htmlLink: null,
        conferenceLink: null,
        organizer: null,
        attendees: [],
        metadata,
        syncedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never);
    await service.createWorkflow({
      title: "After each meeting",
      triggerType: "event",
      schedule: { kind: "event", eventKind: "calendar.event.ended" },
      actionPlan: {
        steps: [
          {
            kind: "create_task",
            request: {
              title: "Minted after a meeting",
              kind: "task",
              cadence: { kind: "unscheduled" },
              timezone: "UTC",
            },
          },
        ],
      },
    });
    const mintedTasks = async () =>
      (await service.listDefinitions()).filter(
        (record) => record.definition.title === "Minted after a meeting",
      );
    const runDue = () =>
      service.runDueEventWorkflows({
        now: new Date().toISOString(),
        limit: 12,
      });

    // An Outlook-only meeting runs the workflow.
    const outlookEnd = T0 + 60 * 60_000;
    vi.setSystemTime(outlookEnd + 60_000);
    await storeEndedEvent("outlook-1", "microsoft", outlookEnd, {
      iCalUId: "uid-outlook-only",
    });
    expect((await runDue()).map((run) => run.startedAt)).toEqual([
      new Date(outlookEnd).toISOString(),
    ]);
    expect(await mintedTasks()).toHaveLength(1);

    // One meeting stored by both calendars runs the workflow once.
    const sharedEnd = T0 + 3 * 60 * 60_000;
    vi.setSystemTime(sharedEnd + 60_000);
    await storeEndedEvent("google-shared", "google", sharedEnd, {
      iCalUID: "uid-shared",
    });
    await storeEndedEvent("outlook-shared", "microsoft", sharedEnd, {
      iCalUId: "uid-shared",
    });
    expect(await runDue()).toHaveLength(1);
    expect(await mintedTasks()).toHaveLength(2);
    // The second copy does not run on a later tick either.
    vi.setSystemTime(sharedEnd + 5 * 60_000);
    expect(await runDue()).toHaveLength(0);
    expect(await mintedTasks()).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 180_000);
