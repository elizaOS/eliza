/**
 * First-run customize path e2e — walks the 5-question set, asserts the
 * questions surface in order, conditional Q5 only fires when categories
 * include "follow-ups", channel-validation produces a fallback warning,
 * and the seeded ScheduledTask set matches the answers.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  FirstRunService,
  readFallbackScheduledTasks,
} from "../src/lifeops/first-run/service.ts";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
} from "../src/lifeops/first-run/state.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function newService(runtime: IAgentRuntime): FirstRunService {
  return new FirstRunService(runtime, {
    stateStore: createFirstRunStateStore(runtime),
    factStore: createOwnerFactStore(runtime),
  });
}

describe("first-run customize e2e", () => {
  it("walks questions in order and seeds answers + tasks", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    const service = newService(runtime);

    // Q1
    let res = await service.runCustomizePath({});
    expect(res.awaitingQuestion).toBe("preferredName");

    res = await service.runCustomizePath({ preferredName: "Sam" });
    expect(res.awaitingQuestion).toBe("timezoneAndWindows");

    // Q2
    res = await service.runCustomizePath({
      timezone: "America/Los_Angeles",
      morningWindow: { startLocal: "06:00", endLocal: "11:00" },
      eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
    });
    expect(res.awaitingQuestion).toBe("categories");

    // Q3 — pick categories without follow-ups (Q5 should be skipped).
    res = await service.runCustomizePath({
      categories: ["sleep tracking", "reminder packs"],
    });
    expect(res.awaitingQuestion).toBe("channel");

    // Q4 — channel-validation fallback (telegram is registered but not
    // connected in the test inspector).
    res = await service.runCustomizePath({ channel: "telegram" });
    expect(res.status).toBe("ok");
    expect(res.warnings.length).toBeGreaterThanOrEqual(1);
    expect(res.warnings[0]).toMatch(/fall back/i);
    expect(res.scheduledTasks.length).toBe(4);
  });

  it("asks Q5 when categories include follow-ups", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    const service = newService(runtime);

    await service.runCustomizePath({ preferredName: "Pat" });
    await service.runCustomizePath({
      timezone: "UTC",
      morningWindow: { startLocal: "07:00", endLocal: "12:00" },
      eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
    });
    await service.runCustomizePath({
      categories: ["follow-ups", "reminder packs"],
    });
    let res = await service.runCustomizePath({ channel: "in_app" });
    expect(res.awaitingQuestion).toBe("relationships");

    res = await service.runCustomizePath({
      relationships: [
        { name: "Alice", cadenceDays: 14 },
        { name: "Bob", cadenceDays: 30 },
      ],
    });
    expect(res.status).toBe("ok");
    expect(res.facts.preferredName).toBe("Pat");
    const tasks = await readFallbackScheduledTasks(runtime);
    expect(tasks.length).toBe(4);
  });
});
