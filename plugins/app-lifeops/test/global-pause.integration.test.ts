/**
 * `GlobalPauseStore` integration test — pause sets the window, current()
 * reflects active state inside the window, clear() returns to inactive.
 *
 * The W1-A runner is the one that consults `current()` pre-fire and skips
 * tasks with `respectsGlobalPause: true`. This test asserts the contract
 * the runner reads.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { lifeOpsPauseAction } from "../src/actions/lifeops-pause.ts";
import { createGlobalPauseStore } from "../src/lifeops/global-pause/store.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function makeMessage(runtime: IAgentRuntime) {
  return {
    id: "msg" as never,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    agentId: runtime.agentId,
    content: { text: "pause everything" },
    createdAt: Date.now(),
  };
}

describe("global pause integration", () => {
  it("pause + current + clear lifecycle works", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    const store = createGlobalPauseStore(runtime);

    expect((await store.current()).active).toBe(false);

    const startIso = new Date(Date.now() - 60_000).toISOString();
    const endIso = new Date(Date.now() + 86_400_000).toISOString();
    await store.set({ startIso, endIso, reason: "vacation" });

    const active = await store.current();
    expect(active.active).toBe(true);
    expect(active.reason).toBe("vacation");
    expect(active.startIso).toBe(startIso);
    expect(active.endIso).toBe(endIso);

    // After endIso, no longer active.
    const afterEnd = await store.current(new Date(Date.parse(endIso) + 1));
    expect(afterEnd.active).toBe(false);

    await store.clear();
    expect((await store.current()).active).toBe(false);
  });

  it("LIFEOPS verb=pause through the action handler sets the window", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    let lastText: string | undefined;
    const callback = async (p: { text?: string }) => {
      lastText = p.text;
      return [];
    };
    const endIso = new Date(Date.now() + 86_400_000).toISOString();
    const result = await lifeOpsPauseAction.handler?.(
      runtime,
      makeMessage(runtime) as never,
      undefined,
      { parameters: { verb: "pause", endIso, reason: "vacation" } },
      callback,
      [],
    );
    expect(result?.success).toBe(true);
    expect(lastText).toMatch(/Paused/);
    const store = createGlobalPauseStore(runtime);
    const status = await store.current();
    expect(status.active).toBe(true);
  });

  it("LIFEOPS verb=wipe requires confirmation", async () => {
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    let lastData: { requiresConfirmation?: boolean } | undefined;
    const callback = async (p: { text?: string; data?: unknown }) => {
      lastData = p.data as { requiresConfirmation?: boolean } | undefined;
      return [];
    };
    const r1 = await lifeOpsPauseAction.handler?.(
      runtime,
      makeMessage(runtime) as never,
      undefined,
      { parameters: { verb: "wipe" } },
      callback,
      [],
    );
    expect(r1?.success).toBe(false);
    expect(lastData?.requiresConfirmation).toBe(true);

    const r2 = await lifeOpsPauseAction.handler?.(
      runtime,
      makeMessage(runtime) as never,
      undefined,
      { parameters: { verb: "wipe", confirmed: true } },
      callback,
      [],
    );
    expect(r2?.success).toBe(true);
  });

  it("respectsGlobalPause contract: gate fn skips true tasks, fires false tasks", async () => {
    // The runner is W1-A; we assert the helper a runner would write.
    const runtime = createMinimalRuntimeStub() as unknown as IAgentRuntime;
    const store = createGlobalPauseStore(runtime);
    await store.set({ startIso: new Date(Date.now() - 60_000).toISOString() });

    const status = await store.current();
    expect(status.active).toBe(true);

    // Mimic the runner pre-fire decision the W1-A spec describes:
    function shouldSkip(
      task: { respectsGlobalPause: boolean },
      pauseStatus: { active: boolean },
    ): boolean {
      return pauseStatus.active && task.respectsGlobalPause;
    }
    expect(shouldSkip({ respectsGlobalPause: true }, status)).toBe(true);
    expect(shouldSkip({ respectsGlobalPause: false }, status)).toBe(false);
  });
});
