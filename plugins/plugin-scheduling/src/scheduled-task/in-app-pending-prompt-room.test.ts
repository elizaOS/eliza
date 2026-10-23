/**
 * An in-app check-in is answered in the owner's chat room. The runner must
 * record that room as the pending-prompt room, or the owner's reply can never
 * be matched to the prompt and `user_replied_within` never completes.
 */
import { describe, expect, it } from "vitest";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
} from "./runner.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type {
  ActivitySignalBusView,
  GlobalPauseView,
  OwnerFactsView,
  SubjectStoreView,
} from "./types.js";

const OWNER_CHAT_ROOM = "00000000-0000-0000-0000-00000000chat";

function makeRunner() {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const store = createInMemoryScheduledTaskStore();
  const ownerFacts: OwnerFactsView = {
    timezone: "UTC",
    morningWindow: { start: "07:00", end: "10:00" },
  };
  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    store,
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ownerFacts,
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false } as ActivitySignalBusView,
    subjectStore: { wasUpdatedSince: () => false } as SubjectStoreView,
    dispatcher: {
      dispatch: async () => ({
        ok: true,
        channelKey: "in_app",
        target: "in_app",
        messageId: "in_app:task:fire",
        metadata: { ownerChatRoomId: OWNER_CHAT_ROOM },
      }),
    },
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date("2026-05-09T09:00:00.000Z"),
  });
  return { runner, store };
}

describe("in-app pending prompt room", () => {
  it("records the owner's chat room, not the in_app target name", async () => {
    const { runner, store } = makeRunner();
    const task = await runner.schedule({
      kind: "checkin",
      promptInstructions: "How did the morning go?",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "tester",
      ownerVisible: true,
      completionCheck: { kind: "user_replied_within" },
    });
    const fired = await runner.fireWithResult(task.taskId);
    expect(fired.kind).toBe("fired");
    expect((await store.get(task.taskId))?.metadata?.pendingPromptRoomId).toBe(
      OWNER_CHAT_ROOM,
    );
  });
});
