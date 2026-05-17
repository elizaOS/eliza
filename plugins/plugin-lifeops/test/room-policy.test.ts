/**
 * `roomPolicyProvider` focused integration test.
 *
 * The audit at `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md`
 * line 455 flags `roomPolicyProvider` as having no test. That's not strictly
 * true (`handoff.e2e.test.ts` exercises it as part of J14 group-chat handoff)
 * but it is true that there's no test that owns the provider's contract
 * directly. This file does exactly that.
 *
 * Asserts:
 *   1. With no handoff state, the provider returns the empty/quiet payload.
 *   2. With handoff active, the provider injects a stay-quiet directive,
 *      `roomInHandoff:true` value, and structured `data.handoff` payload
 *      that the planner can read.
 *   3. The provider is registered at position -9 (ahead of capability
 *      providers, behind firstRunProvider) and is `dynamic:true` so it
 *      re-evaluates each turn.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createHandoffStore } from "../src/lifeops/handoff/store.ts";
import { roomPolicyProvider } from "../src/providers/room-policy.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const STATE: State = { values: {}, data: {}, text: "" };

function messageInRoom(
  runtime: IAgentRuntime,
  roomId: string,
  text: string,
): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}` as UUID,
    entityId: runtime.agentId,
    roomId: roomId as UUID,
    agentId: runtime.agentId,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

describe("roomPolicyProvider", () => {
  it("declares position=-9, dynamic=true, cacheScope=turn", () => {
    expect(roomPolicyProvider.name).toBe("roomPolicy");
    expect(roomPolicyProvider.position).toBe(-9);
    expect(roomPolicyProvider.dynamic).toBe(true);
    expect(roomPolicyProvider.cacheScope).toBe("turn");
  });

  it("returns the quiet payload when no handoff is active for the room", async () => {
    const runtime = createMinimalRuntimeStub();
    const result = await roomPolicyProvider.get(
      runtime,
      messageInRoom(runtime, "room-no-handoff", "hello"),
      STATE,
    );
    expect(result.text).toBe("");
    expect(result.values?.roomInHandoff).toBe(false);
    expect(result.data).toEqual({});
  });

  it("returns the quiet payload when message has no roomId", async () => {
    const runtime = createMinimalRuntimeStub();
    const message = {
      id: "no-room" as UUID,
      entityId: runtime.agentId,
      // explicit empty roomId — provider must short-circuit
      roomId: "" as UUID,
      agentId: runtime.agentId,
      content: { text: "no room" },
      createdAt: Date.now(),
    } as Memory;
    const result = await roomPolicyProvider.get(runtime, message, STATE);
    expect(result.text).toBe("");
    expect(result.values?.roomInHandoff).toBe(false);
  });

  it("injects a stay-quiet directive when HandoffStore.status is active", async () => {
    const runtime = createMinimalRuntimeStub();
    const roomId = "room-handoff-1";
    const store = createHandoffStore(runtime);
    await store.enter(roomId, {
      reason: "user asked me to step out",
      resumeOn: { kind: "mention" },
    });

    const result = await roomPolicyProvider.get(
      runtime,
      messageInRoom(runtime, roomId, "carry on without me"),
      STATE,
    );
    expect(result.values?.roomInHandoff).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text).toMatch(/handoff mode/);
    expect(result.text).toMatch(/Do not respond/);
    // Resume condition phrasing surfaces — planner needs that hint.
    expect(result.text.toLowerCase()).toContain("mention");

    const data = result.data as {
      handoff?: {
        active?: boolean;
        reason?: string;
        resumeOn?: { kind: string };
      };
    };
    expect(data.handoff?.active).toBe(true);
    expect(data.handoff?.reason).toBe("user asked me to step out");
    expect(data.handoff?.resumeOn?.kind).toBe("mention");
  });

  it("returns the quiet payload after store.exit clears the room", async () => {
    const runtime = createMinimalRuntimeStub();
    const roomId = "room-handoff-2";
    const store = createHandoffStore(runtime);
    await store.enter(roomId, {
      reason: "test",
      resumeOn: { kind: "explicit_resume" },
    });
    await store.exit(roomId);

    const result = await roomPolicyProvider.get(
      runtime,
      messageInRoom(runtime, roomId, "still here?"),
      STATE,
    );
    expect(result.values?.roomInHandoff).toBe(false);
    expect(result.text).toBe("");
  });

  it("scopes per room — handoff in roomA does not silence roomB", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createHandoffStore(runtime);
    await store.enter("room-A", {
      reason: "scoped",
      resumeOn: { kind: "mention" },
    });

    const a = await roomPolicyProvider.get(
      runtime,
      messageInRoom(runtime, "room-A", "msg in A"),
      STATE,
    );
    const b = await roomPolicyProvider.get(
      runtime,
      messageInRoom(runtime, "room-B", "msg in B"),
      STATE,
    );
    expect(a.values?.roomInHandoff).toBe(true);
    expect(b.values?.roomInHandoff).toBe(false);
  });
});
