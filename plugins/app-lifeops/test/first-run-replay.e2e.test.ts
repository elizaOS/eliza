/**
 * First-run replay e2e — re-runs first-run after completion, asserts that:
 *   - existing ScheduledTask records keep their idempotencyKey (upsert-safe)
 *   - OwnerFactStore facts touched by the questions are updated
 *   - fact updates show through after the replay completes
 *
 * Re-entry: invoking FIRST_RUN with path=defaults after completion routes
 * to replay automatically (per IMPLEMENTATION_PLAN §3.3).
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { firstRunAction } from "../src/actions/first-run.ts";
import { DEFAULT_PACK_IDEMPOTENCY_KEYS } from "../src/lifeops/first-run/defaults.ts";
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

function makeMessage(runtime: IAgentRuntime): Memory {
  return {
    id: "msg-1" as Memory["id"],
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    agentId: runtime.agentId,
    content: { text: "rerun setup" },
    createdAt: Date.now(),
  } as Memory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("first-run replay e2e", () => {
  it("replay preserves idempotency keys; facts update", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = newService(runtime);

    // Initial defaults run.
    await service.runDefaultsPath({});
    const finished = await service.runDefaultsPath({ wakeTime: "6:00am" });
    expect(finished.status).toBe("ok");

    const tasksBefore = await readFallbackScheduledTasks(runtime);
    const idsBefore = tasksBefore.map((t) => t.input.idempotencyKey);
    expect(idsBefore).toEqual(
      expect.arrayContaining([
        DEFAULT_PACK_IDEMPOTENCY_KEYS.gm,
        DEFAULT_PACK_IDEMPOTENCY_KEYS.gn,
        DEFAULT_PACK_IDEMPOTENCY_KEYS.checkin,
        DEFAULT_PACK_IDEMPOTENCY_KEYS.morningBrief,
      ]),
    );

    // Replay with new facts.
    let r = await service.runReplayPath({
      preferredName: "Updated",
      timezone: "America/Los_Angeles",
      morningWindow: { startLocal: "07:00", endLocal: "12:00" },
      eveningWindow: { startLocal: "19:00", endLocal: "23:00" },
    });
    // Replay still has to walk Q2 (timezone+windows) etc. since the customize
    // questionnaire is the canonical replay flow.
    let guard = 0;
    while (r.status === "needs_more_input" && guard < 10) {
      guard += 1;
      switch (r.awaitingQuestion) {
        case "preferredName":
          r = await service.runReplayPath({ preferredName: "Updated" });
          break;
        case "timezoneAndWindows":
          r = await service.runReplayPath({
            timezone: "America/Los_Angeles",
            morningWindow: { startLocal: "07:00", endLocal: "12:00" },
            eveningWindow: { startLocal: "19:00", endLocal: "23:00" },
          });
          break;
        case "categories":
          r = await service.runReplayPath({
            categories: ["reminder packs"],
          });
          break;
        case "channel":
          r = await service.runReplayPath({ channel: "in_app" });
          break;
        case "relationships":
          r = await service.runReplayPath({ relationships: [] });
          break;
        default:
          r = await service.runReplayPath({});
      }
    }
    expect(r.status).toBe("ok");

    const tasksAfter = await readFallbackScheduledTasks(runtime);
    const idsAfter = tasksAfter.map((t) => t.input.idempotencyKey);
    // Same idempotency keys (upsert-by-key in the in-memory runner).
    expect(idsAfter.sort()).toEqual(idsBefore.sort());
    // Per-key uniqueness: in-memory runner replaced rather than duplicated.
    expect(new Set(idsAfter).size).toBe(idsAfter.length);
    expect(r.facts.preferredName).toBe("Updated");
    expect(r.facts.morningWindow?.startLocal).toBe("07:00");
  });

  it("re-entry: FIRST_RUN path=defaults after complete routes to replay", async () => {
    const runtime = createMinimalRuntimeStub();
    const service = newService(runtime);
    await service.runDefaultsPath({});
    const done = await service.runDefaultsPath({ wakeTime: "6:00am" });
    expect(done.status).toBe("ok");

    let lastPayload: { text?: string; data?: unknown } | null = null;
    const callback = async (p: { text?: string; data?: unknown }) => {
      lastPayload = p;
      return [];
    };
    // Calling defaults again — the action should switch to replay and
    // immediately ask the next replay question (timezoneAndWindows or
    // similar) rather than the wake-time question.
    const result = await firstRunAction.handler?.(
      runtime,
      makeMessage(runtime),
      undefined,
      { parameters: { path: "defaults" } },
      callback,
      [],
    );
    expect(result?.success).toBe(true);
    // Replay walks the customize questions; since we never set the
    // preferredName via customize, the first ask is the preferredName
    // question.
    const callbackData = isRecord(lastPayload?.data) ? lastPayload.data : {};
    expect(callbackData.awaitingQuestion).toBeDefined();
  });
});
