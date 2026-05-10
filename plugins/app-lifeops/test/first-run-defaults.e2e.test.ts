/**
 * First-run defaults path e2e — ask wake time once, schedule the four-task
 * default pack, mark first-run complete, provider goes silent.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { firstRunAction } from "../src/actions/first-run.ts";
import {
  FirstRunService,
  readFallbackScheduledTasks,
} from "../src/lifeops/first-run/service.ts";
import {
  createFirstRunStateStore,
  createOwnerFactStore,
} from "../src/lifeops/first-run/state.ts";
import { firstRunProvider } from "../src/providers/first-run.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function makeMessage(runtime: IAgentRuntime, text: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}` as Memory["id"],
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    agentId: runtime.agentId,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

const STATE: State = { values: {}, data: {}, text: "" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("first-run defaults e2e", () => {
  it("provider surfaces affordance when pending; goes silent after completion", async () => {
    const runtime = createMinimalRuntimeStub();
    const provider = firstRunProvider;
    const before = await provider.get(
      runtime,
      makeMessage(runtime, "what can you do?"),
      STATE,
    );
    expect(before.values?.firstRunPending).toBe(true);
    expect(before.text).toMatch(/First-run/);

    // Run defaults to completion.
    const stateStore = createFirstRunStateStore(runtime);
    const factStore = createOwnerFactStore(runtime);
    const service = new FirstRunService(runtime, { stateStore, factStore });
    const ask = await service.runDefaultsPath({});
    expect(ask.status).toBe("needs_more_input");
    const done = await service.runDefaultsPath({ wakeTime: "6:30am" });
    expect(done.status).toBe("ok");
    expect(done.scheduledTasks.length).toBe(4);

    const after = await provider.get(
      runtime,
      makeMessage(runtime, "what can you do?"),
      STATE,
    );
    expect(after.values?.firstRunPending).toBe(false);
    expect(after.text).toBe("");
  });

  it("FIRST_RUN action drives the defaults path through the action handler", async () => {
    const runtime = createMinimalRuntimeStub();
    const message = makeMessage(runtime, "set me up");

    let lastCallback: { text?: string; data?: unknown } | null = null;
    const callback = async (payload: { text?: string; data?: unknown }) => {
      lastCallback = payload;
      return [];
    };

    // Step 1: action without wake time -> awaiting question.
    const r1 = await firstRunAction.handler?.(
      runtime,
      message,
      undefined,
      { parameters: { path: "defaults" } },
      callback,
      [],
    );
    expect(r1?.success).toBe(true);
    expect(lastCallback?.text).toMatch(/wake up/i);

    // Step 2: action with wake time -> complete.
    const r2 = await firstRunAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          path: "defaults",
          partialAnswers: { wakeTime: "6:30am" },
        },
      },
      callback,
      [],
    );
    expect(r2?.success).toBe(true);
    expect(lastCallback?.text).toMatch(/Defaults applied/);
    const callbackData = isRecord(lastCallback?.data)
      ? lastCallback.data
      : {};
    expect(callbackData.scheduledTaskIds).toHaveLength(4);

    const fallbackTasks = await readFallbackScheduledTasks(runtime);
    expect(fallbackTasks.length).toBe(4);
    const slots = new Set(
      fallbackTasks
        .map((t) => t.input.metadata?.slot)
        .filter(Boolean) as string[],
    );
    expect(slots).toEqual(new Set(["gm", "gn", "checkin", "morningBrief"]));
  });
});
