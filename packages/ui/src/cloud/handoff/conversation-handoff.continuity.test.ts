/**
 * Unit coverage for conversation-handoff message continuity (no drops/dupes
 * across the swap). Deps injected, no live cloud.
 */
import { describe, expect, it } from "vitest";
import {
  type ConversationHandoffDeps,
  type HandoffMessage,
  runConversationHandoff,
  toHandoffMessages,
} from "./conversation-handoff";

/**
 * Conversation-continuity guard for the shared→dedicated handoff (issue #8810
 * acceptance criterion: "messages sent on the shared adapter appear after the
 * switch to the dedicated container").
 *
 * The live two-agent script (`__integration__/two-agent-handoff.mts`) proves
 * this against two booted agents but is NOT collected by the test runner. This
 * test models the same property with an in-memory shared store (A) and personal
 * store (B) whose `import` mirrors the real silent-import primitive
 * (`POST /api/conversations/:id/import`): order-preserving, no inference, and
 * idempotent (a re-import into an already-populated room is a no-op). It then
 * drives the real `runConversationHandoff` orchestrator end to end so the
 * continuity contract is guarded in CI.
 */

/** A raw `/messages` row as the shared agent's REST API returns it. */
type RawMessage = { role: string; text: string; timestamp: number };

function makeTwoAgentWorld(sharedHistory: RawMessage[]) {
  // What the dedicated container holds. Starts empty; the import fills it.
  const personalStore: HandoffMessage[] = [];
  let liveBase = "https://shared.elizacloud.ai";

  const deps: ConversationHandoffDeps = {
    checkPersonalReady: async () => ({
      ready: true,
      apiBase: "https://agent-7.elizacloud.ai",
    }),
    readSharedMessages: async () => toHandoffMessages(sharedHistory),
    importToPersonal: async (messages) => {
      // Mirror the real primitive: idempotent — once the room is populated a
      // re-import inserts nothing and reports it.
      if (personalStore.length > 0) {
        return { inserted: 0, alreadyPopulated: true };
      }
      for (const m of messages) personalStore.push(m);
      return { inserted: messages.length };
    },
    switchToPersonal: (personal) => {
      if (personal.apiBase) liveBase = personal.apiBase;
    },
    sleep: async () => {},
  };

  return {
    deps,
    personalStore,
    get liveBase() {
      return liveBase;
    },
  };
}

const SHARED_HISTORY: RawMessage[] = [
  { role: "user", text: "hello from the shared agent", timestamp: 10 },
  {
    role: "assistant",
    text: "hi — your personal agent is booting",
    timestamp: 20,
  },
  { role: "user", text: "great, I'll keep chatting", timestamp: 30 },
  { role: "assistant", text: "all of this will come with you", timestamp: 40 },
];

describe("handoff conversation continuity", () => {
  it("the shared conversation appears, in order, on the dedicated container after the switch", async () => {
    const world = makeTwoAgentWorld(SHARED_HISTORY);

    const result = await runConversationHandoff(world.deps);

    expect(result.status).toBe("switched");
    expect(result.imported).toBe(SHARED_HISTORY.length);

    // Every shared message is now on the dedicated container, in send order.
    expect(world.personalStore.map((m) => m.text)).toEqual([
      "hello from the shared agent",
      "hi — your personal agent is booting",
      "great, I'll keep chatting",
      "all of this will come with you",
    ]);
    expect(world.personalStore.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // The live client is now pointed at the dedicated container, not shared.
    expect(world.liveBase).toBe("https://agent-7.elizacloud.ai");
  });

  it("re-running the handoff is idempotent — no duplicated history on the dedicated container", async () => {
    const world = makeTwoAgentWorld(SHARED_HISTORY);

    await runConversationHandoff(world.deps);
    const afterFirst = world.personalStore.map((m) => m.text);

    // A retry (e.g. after a transient switch failure) must not double the room.
    const second = await runConversationHandoff(world.deps);

    expect(second.status).toBe("switched");
    expect(second.imported).toBe(0); // already populated → nothing re-inserted
    expect(world.personalStore.map((m) => m.text)).toEqual(afterFirst);
    expect(world.personalStore).toHaveLength(SHARED_HISTORY.length);
  });

  it("a message sent on the shared adapter just before the swap still carries over", async () => {
    const history = [...SHARED_HISTORY];
    const world = makeTwoAgentWorld(history);
    // The user fires one more message on the shared adapter right before the
    // dedicated container reports ready; it must be part of the imported set.
    history.push({
      role: "user",
      text: "one last thing before you switch",
      timestamp: 50,
    });

    const result = await runConversationHandoff(world.deps);

    expect(result.imported).toBe(history.length);
    expect(world.personalStore.at(-1)?.text).toBe(
      "one last thing before you switch",
    );
  });
});
