/**
 * Validates that the produced first-run scheduled-task pack is shape-valid
 * per the W1-A `ScheduledTask` contract: required fields are present, every
 * trigger.kind is in the registered set, every priority is in the registered
 * set, every `respectsGlobalPause` is set, every task has an `idempotencyKey`
 * (so replay upserts), and that the customize finalizer's channel-validation
 * fallback path produces an in_app channel + warning.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildDefaultsPack } from "../src/lifeops/first-run/defaults.ts";
import {
  parseCategories,
  parseRelationships,
  parseTimeWindow,
  parseTimezone,
  setChannelInspector,
  validateChannel,
} from "../src/lifeops/first-run/questions.ts";
import { FirstRunService } from "../src/lifeops/first-run/service.ts";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
} from "../src/lifeops/first-run/state.ts";
import type {
  ScheduledTask,
  ScheduledTaskInput,
} from "../src/lifeops/wave1-types.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const VALID_TRIGGER_KINDS = new Set([
  "once",
  "cron",
  "interval",
  "relative_to_anchor",
  "during_window",
  "event",
  "manual",
  "after_task",
]);
const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const VALID_KINDS = new Set([
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
]);

function asScheduledTask(input: ScheduledTaskInput): ScheduledTaskInput {
  expect(VALID_KINDS.has(input.kind)).toBe(true);
  expect(VALID_PRIORITIES.has(input.priority)).toBe(true);
  expect(VALID_TRIGGER_KINDS.has(input.trigger.kind)).toBe(true);
  expect(typeof input.respectsGlobalPause).toBe("boolean");
  expect(typeof input.idempotencyKey).toBe("string");
  expect(typeof input.promptInstructions).toBe("string");
  expect(input.promptInstructions.length).toBeGreaterThan(0);
  expect(input.source).toBe("first_run");
  return input;
}

describe("first-run config validation", () => {
  it("buildDefaultsPack emits four shape-valid ScheduledTask inputs", () => {
    const pack = buildDefaultsPack({
      morningWindow: { startLocal: "06:30", endLocal: "11:30" },
      timezone: "America/Los_Angeles",
      agentId: "agent-1",
      channel: "in_app",
    });
    expect(pack.length).toBe(4);
    pack.forEach(asScheduledTask);
    // Specific slot assertions
    const slots = new Set(
      pack.map((p) => (p.metadata?.slot ?? null) as string | null),
    );
    expect(slots).toEqual(new Set(["gm", "gn", "checkin", "morningBrief"]));
    const checkin = pack.find((p) => p.metadata?.slot === "checkin");
    expect(checkin?.completionCheck?.kind).toBe("user_replied_within");
    const morningBrief = pack.find((p) => p.metadata?.slot === "morningBrief");
    expect(morningBrief?.trigger.kind).toBe("relative_to_anchor");
    if (morningBrief?.trigger.kind === "relative_to_anchor") {
      expect(morningBrief.trigger.anchorKey).toBe("wake.confirmed");
    }
  });

  it("parseTimezone / parseTimeWindow accept valid input and reject garbage", () => {
    expect(parseTimezone("America/New_York")).toBe("America/New_York");
    expect(parseTimezone("")).toBe(null);
    expect(parseTimeWindow({ startLocal: "06:00", endLocal: "11:00" })).toEqual(
      { startLocal: "06:00", endLocal: "11:00" },
    );
    expect(parseTimeWindow({ startLocal: "11:00", endLocal: "06:00" })).toBe(
      null,
    );
    expect(parseTimeWindow({ startLocal: "25:00", endLocal: "30:00" })).toBe(
      null,
    );
  });

  it("parseCategories filters to the allowed set", () => {
    expect(
      parseCategories([
        "sleep tracking",
        "ALIENS",
        "follow-ups",
        " inbox triage ",
      ]),
    ).toEqual(["sleep tracking", "follow-ups"]);
  });

  it("parseRelationships shapes user input and bounds at 5 entries", () => {
    const result = parseRelationships(
      Array.from({ length: 8 }, (_, i) => ({
        name: `Person ${i}`,
        cadenceDays: i + 1,
      })),
    );
    expect(result?.length).toBe(5);
  });

  it("validateChannel falls back to in_app + warning for unconnected channels", () => {
    const runtime = createMinimalRuntimeStub();
    const result = validateChannel("telegram", runtime);
    expect(result.fallbackToInApp).toBe(true);
    expect(result.warning).toMatch(/fall back/i);
  });

  it("validateChannel passes a connected channel through cleanly", () => {
    setChannelInspector({
      isRegistered: () => true,
      isConnected: () => true,
    });
    const runtime = createMinimalRuntimeStub();
    const result = validateChannel("telegram", runtime);
    expect(result.fallbackToInApp).toBe(false);
    expect(result.warning).toBeUndefined();
    setChannelInspector(null);
  });

  it("rejects an unregistered channel with the right warning", () => {
    const runtime = createMinimalRuntimeStub();
    const result = validateChannel("morse_code", runtime);
    expect(result.channel).toBe("in_app");
    expect(result.fallbackToInApp).toBe(true);
    expect(result.warning).toMatch(/not registered/i);
  });

  it("FirstRunService produces shape-valid tasks via the in-memory runner", async () => {
    const runtime = createMinimalRuntimeStub();
    const stateStore = createFirstRunStateStore(runtime);
    const factStore = createOwnerFactStore(runtime);
    const recorded: ScheduledTask[] = [];
    const service = new FirstRunService(runtime, {
      stateStore,
      factStore,
      runner: {
        async schedule(input) {
          asScheduledTask(input);
          const task: ScheduledTask = {
            ...input,
            taskId: `t-${recorded.length}`,
            state: { status: "scheduled", followupCount: 0 },
          };
          recorded.push(task);
          return task;
        },
      },
    });

    // First call without a wake time returns the question.
    const ask = await service.runDefaultsPath({});
    expect(ask.status).toBe("needs_more_input");
    expect(ask.awaitingQuestion).toBe("wakeTime");

    const done = await service.runDefaultsPath({ wakeTime: "6:30am" });
    expect(done.status).toBe("ok");
    expect(done.scheduledTasks.length).toBe(4);
    expect(recorded.length).toBe(4);
    expect(done.facts.morningWindow?.startLocal).toBe("06:30");
  });
});
