/**
 * First-run customize path e2e — walks the reduced 3-question set (name →
 * categories → channel), asserts timezone/windows are NEVER asked as form
 * steps, that a follow-ups category does not force a typed relationship list,
 * channel-validation produces a fallback warning, and the seeded ScheduledTask
 * set matches the answers. Also asserts provenance: the device timezone lands
 * as `agent_inferred` and no window is stamped `first_run`, so the observed
 * activity learner stays live (#14691). Deterministic in-memory runtime stub.
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
  it("asks only name → categories → channel; never timezone/windows", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = newService(runtime);

    // Q1
    let res = await service.runCustomizePath({});
    expect(res.awaitingQuestion).toBe("preferredName");

    // Answering the name advances straight to categories — timezone/windows
    // are inferred, not asked.
    res = await service.runCustomizePath({ preferredName: "Sam" });
    expect(res.awaitingQuestion).toBe("categories");

    // Categories → channel (no timezone/window step in between).
    res = await service.runCustomizePath({
      categories: ["sleep tracking", "reminder packs"],
    });
    expect(res.awaitingQuestion).toBe("channel");

    // Channel-validation fallback (telegram is registered but not connected in
    // the test inspector).
    res = await service.runCustomizePath({ channel: "telegram" });
    expect(res.status).toBe("ok");
    expect(res.warnings.length).toBeGreaterThanOrEqual(1);
    expect(res.warnings[0]).toMatch(/fall back/i);
    expect(res.scheduledTasks.length).toBe(6);
  });

  it("does NOT ask for a relationship list when follow-ups is enabled", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = newService(runtime);

    await service.runCustomizePath({ preferredName: "Pat" });
    await service.runCustomizePath({
      categories: ["follow-ups", "reminder packs"],
    });
    // Selecting the channel completes the flow — relationships are discovered
    // passively via the entity/relationship graph, never typed up front.
    const res = await service.runCustomizePath({ channel: "in_app" });
    expect(res.status).toBe("ok");
    expect(res.awaitingQuestion).toBeUndefined();
    expect(res.facts.preferredName).toBe("Pat");
    const tasks = await readFallbackScheduledTasks(runtime);
    expect(tasks.length).toBe(6);
  });

  it("infers the device timezone as agent_inferred and writes no first_run window", async () => {
    const runtime = createMinimalRuntimeStub();
    const factStore = createOwnerFactStore(runtime);
    const service = new FirstRunService(runtime, {
      stateStore: createFirstRunStateStore(runtime),
      factStore,
    });

    // The device zone is threaded in as the inferred `timezone` input, not
    // asked as a question — it may accompany any answer in the flow.
    await service.runCustomizePath({
      preferredName: "Sam",
      timezone: "America/Los_Angeles",
    });
    await service.runCustomizePath({ categories: ["reminder packs"] });
    const done = await service.runCustomizePath({ channel: "in_app" });
    expect(done.status).toBe("ok");

    const facts = await factStore.read();
    // Timezone captured from the device is inferred, never a typed answer.
    expect(facts.timezone?.value).toBe("America/Los_Angeles");
    expect(facts.timezone?.provenance.source).toBe("agent_inferred");
    // The name IS a stated answer.
    expect(facts.preferredName?.provenance.source).toBe("first_run");
    // No window is written as a user-owned fact — the learner owns windows.
    expect(facts.morningWindow?.provenance.source).not.toBe("first_run");
    expect(facts.eveningWindow?.provenance.source).not.toBe("first_run");
  });

  it("a boot seed after a completed customize run does not double-seed", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = newService(runtime);

    await service.runCustomizePath({
      preferredName: "Sam",
      timezone: "America/Los_Angeles",
    });
    await service.runCustomizePath({ categories: ["reminder packs"] });
    const done = await service.runCustomizePath({ channel: "in_app" });
    expect(done.status).toBe("ok");
    expect(done.scheduledTasks.length).toBe(6);

    const beforeBoot = await readFallbackScheduledTasks(runtime);
    expect(beforeBoot.length).toBe(6);

    // Boot seeding reuses the same per-key marker the customize run wrote, so
    // no new rows appear.
    const boot = await newService(runtime).seedDefaultPackOnBoot();
    expect(boot.seeded.length).toBe(0);
    expect(boot.skipped.length).toBe(6);

    const afterBoot = await readFallbackScheduledTasks(runtime);
    expect(afterBoot.length).toBe(6);
  });
});
