/**
 * `PendingPromptsProvider` integration test — fire a check-in (record an open
 * prompt), inbound arrives, the provider returns the open prompt list so
 * the planner can route to `complete` instead of treating the inbound as a
 * fresh request. Also asserts retain-window expiry and the resolve path.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createPendingPromptsStore } from "../src/lifeops/pending-prompts/store.ts";
import {
  createPendingPromptsProvider,
  pendingPromptsProvider,
} from "../src/providers/pending-prompts.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

function makeMessage(runtime: IAgentRuntime, roomId: string): Memory {
  return {
    id: "msg" as Memory["id"],
    entityId: runtime.agentId,
    roomId,
    agentId: runtime.agentId,
    content: { text: "yeah I checked in" },
    createdAt: Date.now(),
  } as Memory;
}

describe("pending prompts integration", () => {
  it("records on fire, surfaces via provider, resolves on terminal verb", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createPendingPromptsStore(runtime);
    const roomId = "room-checkin-1";
    await store.record({
      taskId: "task-checkin-1",
      roomId,
      promptSnippet: "How are you feeling and what's on your plate today?",
      firedAt: new Date().toISOString(),
      expectedReplyKind: "free_form",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    // Provider returns the open prompt for that room.
    const result = await pendingPromptsProvider.get(
      runtime,
      makeMessage(runtime, roomId),
      { values: {}, data: {}, text: "" } as never,
    );
    expect(result.values?.pendingPromptCount).toBe(1);
    const data = result.data?.pendingPrompts as Array<{ taskId: string }>;
    expect(data[0]?.taskId).toBe("task-checkin-1");

    // The provider helper used by the planner correlation step.
    const helper = createPendingPromptsProvider(runtime);
    const list = await helper.list(roomId);
    expect(list.length).toBe(1);

    // Planner records terminal verb -> resolve removes the prompt.
    await store.resolve(roomId, "task-checkin-1");
    const after = await helper.list(roomId);
    expect(after.length).toBe(0);
  });

  it("retains expired prompts for the reopen window then drops them", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createPendingPromptsStore(runtime);
    const roomId = "room-checkin-2";
    const firedAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const expiresAt = new Date(Date.now() - 24.5 * 3_600_000).toISOString();
    await store.record({
      taskId: "task-old",
      roomId,
      promptSnippet: "old",
      firedAt,
      expectedReplyKind: "any",
      expiresAt,
      reopenWindowHours: 24,
    });
    // Expired well past the 24h reopen window, so list returns nothing.
    const list = await store.list(roomId);
    expect(list.length).toBe(0);
  });

  it("late inbound within reopen window still correlates", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createPendingPromptsStore(runtime);
    const roomId = "room-checkin-3";
    // Expired 1h ago; reopen window is 24h, so still surfaces.
    const firedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const expiresAt = new Date(Date.now() - 1 * 3_600_000).toISOString();
    await store.record({
      taskId: "task-late",
      roomId,
      promptSnippet: "still reachable",
      firedAt,
      expiresAt,
    });
    const list = await store.list(roomId);
    expect(list.length).toBe(1);
    expect(list[0].taskId).toBe("task-late");
  });
});
