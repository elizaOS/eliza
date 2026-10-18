/**
 * The ongoing-tasks provider tells the model when each automation runs. The
 * line must keep the exact schedule: an interval that is not whole hours, the
 * cron time zone, the one-time instant and the event kind. Real runtime,
 * SQLite store and provider; harness as in providers-report-read-failures.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { createOngoingTasksProvider } from "../src/providers/tasks.ts";

it("gives the model the exact schedule of each automation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-trigger-schedules-"));
  const owner = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: {
      name: "Probe",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.initialize({ skipMigrations: true });
  try {
    const roomId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "w",
      metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
    });
    await runtime.createRoom({
      id: roomId,
      agentId: runtime.agentId,
      worldId,
      source: "web",
      type: "DM" as never,
      name: "automation",
    });
    const triggers = [
      {
        displayName: "Standup check",
        triggerType: "interval",
        intervalMs: 90 * 60_000,
      },
      {
        displayName: "Morning digest",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        timezone: "America/New_York",
      },
      {
        displayName: "Dentist reminder",
        triggerType: "once",
        scheduledAtIso: "2026-10-20T15:00:00.000Z",
      },
      {
        displayName: "Inbox watch",
        triggerType: "event",
        eventKind: "MESSAGE_RECEIVED",
      },
    ];
    for (const [index, trigger] of triggers.entries()) {
      await runtime.createTask({
        name: trigger.displayName,
        roomId,
        worldId,
        tags: ["repeat", "trigger"],
        metadata: {
          trigger: {
            triggerId: `trg-${index}`,
            enabled: true,
            instructions: "Do the thing",
            ...trigger,
          },
        },
      } as never);
    }
    const message = {
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: { text: "when do my automations run?" },
      createdAt: Date.now(),
    } as Memory;

    const result = await createOngoingTasksProvider().get(runtime, message, {
      values: {},
      data: {},
      text: "",
    });

    expect(result.text).toContain("Standup check (every 90 minutes)");
    expect(result.text).toContain(
      "Morning digest (cron: 0 9 * * * in America/New_York)",
    );
    expect(result.text).toContain(
      "Dentist reminder (once at 2026-10-20T15:00:00.000Z)",
    );
    expect(result.text).toContain("Inbox watch (on event MESSAGE_RECEIVED)");
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
