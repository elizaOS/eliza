/**
 * First-run × window-learning integration (#14691). The keystone regression
 * guard for the architecture fix: first-run must record timezone and the
 * morning/evening windows as INFERRED facts (`agent_inferred`), never as
 * user-owned (`first_run`) answers, so `activity-profile/window-learning.ts`
 * keeps refining the owner's real rhythm afterwards.
 *
 * These drive the real FirstRunService against the real cache-backed
 * OwnerFactStore, then feed the resulting facts through the real
 * `resolveWindowPatch` learner-policy — no mocks. Against the pre-fix behavior
 * (windows stamped `first_run`) the learner-still-live assertions fail, because
 * `USER_OWNED_SOURCES` would freeze the windows.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveWindowPatch } from "../src/activity-profile/window-learning.ts";
import { FirstRunService } from "../src/lifeops/first-run/service.ts";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
  type OwnerFactStore,
} from "../src/lifeops/first-run/state.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function serviceWith(runtime: IAgentRuntime, factStore: OwnerFactStore) {
  return new FirstRunService(runtime, {
    stateStore: createFirstRunStateStore(runtime),
    factStore,
  });
}

describe("first-run keeps window learning live (#14691)", () => {
  it("defaults path stamps inferred windows/timezone as agent_inferred", async () => {
    const runtime = createMinimalRuntimeStub();
    const factStore = createOwnerFactStore(runtime);
    const service = serviceWith(runtime, factStore);

    const done = await service.runDefaultsPath({
      wakeTime: "6:30am",
      timezone: "America/New_York",
    });
    expect(done.status).toBe("ok");

    const facts = await factStore.read();
    // The wake-derived morning window is a heuristic, not a typed window.
    expect(facts.morningWindow?.value.startLocal).toBe("06:30");
    expect(facts.morningWindow?.provenance.source).toBe("agent_inferred");
    // The evening window is a pure default the owner never chose.
    expect(facts.eveningWindow?.provenance.source).toBe("agent_inferred");
    // The timezone is the device zone, inferred not stated.
    expect(facts.timezone?.value).toBe("America/New_York");
    expect(facts.timezone?.provenance.source).toBe("agent_inferred");
  });

  it("the learner can still refine windows after the defaults path", async () => {
    const runtime = createMinimalRuntimeStub();
    const factStore = createOwnerFactStore(runtime);
    const service = serviceWith(runtime, factStore);

    await service.runDefaultsPath({ wakeTime: "6:30am" });
    const facts = await factStore.read();

    // Observed activity says the owner actually rises at 08:00 and winds down
    // toward 23:00 — different from the first-run heuristics.
    const patch = resolveWindowPatch(facts, {
      morningWindow: { startLocal: "08:00", endLocal: "11:00" },
      eveningWindow: { startLocal: "21:00", endLocal: "23:00" },
    });

    // A writable patch means the windows are NOT user-owned-frozen. This is the
    // whole point of the fix: with pre-fix `first_run` provenance this is null.
    expect(patch).not.toBeNull();
    expect(patch?.morningWindow).toEqual({
      startLocal: "08:00",
      endLocal: "11:00",
    });
    expect(patch?.eveningWindow).toEqual({
      startLocal: "21:00",
      endLocal: "23:00",
    });
  });

  it("the learner can still refine windows after the customize path", async () => {
    const runtime = createMinimalRuntimeStub();
    const factStore = createOwnerFactStore(runtime);
    const service = serviceWith(runtime, factStore);

    await service.runCustomizePath({
      preferredName: "Sam",
      timezone: "Europe/Berlin",
    });
    await service.runCustomizePath({ categories: ["reminder packs"] });
    const done = await service.runCustomizePath({ channel: "in_app" });
    expect(done.status).toBe("ok");

    const facts = await factStore.read();
    // Customize never writes a window fact at all — the learner owns them from
    // day one — so any window the learner derives is writable.
    expect(facts.morningWindow).toBeUndefined();
    expect(facts.eveningWindow).toBeUndefined();
    expect(facts.timezone?.provenance.source).toBe("agent_inferred");

    const patch = resolveWindowPatch(facts, {
      morningWindow: { startLocal: "07:30", endLocal: "10:30" },
    });
    expect(patch?.morningWindow).toEqual({
      startLocal: "07:30",
      endLocal: "10:30",
    });
  });
});
