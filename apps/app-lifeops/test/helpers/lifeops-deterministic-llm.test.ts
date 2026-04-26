import crypto from "node:crypto";
import {
  type AgentRuntime,
  createMessageMemory,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  extractActionResultsFromState: () => [],
  extractRecentMessageEntriesFromState: () => [],
  extractStateDataRecords: () => [],
  hasContextSignalForKey: () => false,
  hasPrivateAccess: async () => true,
  renderGroundedActionReply: async (args: { fallback?: string }) =>
    args.fallback ?? "",
  summarizeActiveTrajectory: async () => null,
  summarizeRecentActionHistory: () => [],
}));

import { extractCalendarPlanWithLlm } from "../../src/actions/calendar.js";
import { crossChannelSendAction } from "../../src/actions/cross-channel-send.js";
import { extractGmailPlanWithLlm } from "../../src/actions/gmail.js";
import { createLifeOpsDeterministicLlm } from "./lifeops-deterministic-llm.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000a411" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000b411" as UUID;

function createHarness(): {
  llm: ReturnType<typeof createLifeOpsDeterministicLlm>;
  runtime: AgentRuntime;
} {
  const llm = createLifeOpsDeterministicLlm();
  const cache = new Map<string, unknown>();
  const tasks = new Map<string, object>();
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "LifeOps Test" },
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    useModel: llm.useModel,
    getMemories: async () => [],
    getMemoriesByRoomIds: async () => [],
    getCache: async <T>(key: string) => cache.get(key) as T | undefined,
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    deleteCache: async (key: string) => {
      cache.delete(key);
    },
    createTask: async (task: object & { id?: UUID }) => {
      const id = task.id ?? (crypto.randomUUID() as UUID);
      tasks.set(id, { ...task, id });
      return id;
    },
    deleteTask: async (taskId: UUID) => {
      tasks.delete(taskId);
    },
  } as AgentRuntime;
  return { llm, runtime };
}

function createMessage(runtime: AgentRuntime, text: string): Memory {
  return createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: ROOM_ID,
    content: { text, source: "client_chat" },
  });
}

function createState(recentMessages = ""): State {
  return {
    values: { recentMessages },
    data: {},
    text: recentMessages,
  } as State;
}

describe("LifeOps deterministic LLM fixture", () => {
  it("covers calendar check, add, move, delete, vague, and multi-search planning", async () => {
    const { llm, runtime } = createHarness();

    const cases = [
      {
        prompt: "what's on my calendar today",
        subaction: "feed",
        queries: [],
      },
      {
        prompt: "schedule a meeting with Alex at 3pm tomorrow",
        subaction: "create_event",
        title: "Meeting with Alex",
      },
      {
        prompt: "move my dentist appointment to Friday at 10am",
        subaction: "update_event",
        queries: ["dentist appointment"],
      },
      {
        prompt: "delete the team meeting tomorrow",
        subaction: "delete_event",
        queries: ["team meeting"],
      },
      {
        prompt:
          "search all calendar events for investor dinner, return flight, and dentist",
        subaction: "search_events",
        queries: ["investor dinner", "return flight", "dentist"],
      },
      {
        prompt: "can you help me with calendar stuff?",
        subaction: null,
        shouldAct: false,
      },
    ] as const;

    for (const testCase of cases) {
      const plan = await extractCalendarPlanWithLlm(
        runtime,
        createMessage(runtime, testCase.prompt),
        createState(),
        testCase.prompt,
        "America/Los_Angeles",
      );
      expect(plan.subaction).toBe(testCase.subaction);
      if ("shouldAct" in testCase) {
        expect(plan.shouldAct).toBe(testCase.shouldAct);
      } else {
        expect(plan.shouldAct).toBe(true);
      }
      if ("title" in testCase) {
        expect(plan.title).toBe(testCase.title);
      }
      if ("queries" in testCase) {
        expect(plan.queries).toEqual(testCase.queries);
      }
    }

    expect(llm.calls.some((call) => call.kind === "calendar-plan")).toBe(true);
    expect(llm.calls.some((call) => call.kind === "unhandled")).toBe(false);
  });

  it("covers Gmail/email search across accounts, broad/vague requests, multi-search, and priority triage", async () => {
    const { llm, runtime } = createHarness();

    const cases = [
      {
        prompt: "search Gmail for Suran across my personal and work accounts",
        subaction: "search",
        queries: ["suran account:personal", "suran account:work"],
      },
      {
        prompt: "find emails from Sarah about the report and the venue",
        subaction: "search",
        queries: ["from:sarah report", "from:sarah venue"],
      },
      {
        prompt: "who emailed me today?",
        subaction: "search",
        queries: ["newer_than:1d"],
      },
      {
        prompt: "which emails need a response?",
        subaction: "needs_response",
        replyNeededOnly: true,
      },
      {
        prompt:
          "show urgent blockers first and separate low priority newsletters",
        subaction: "triage",
      },
      {
        prompt: "can you help me with my email?",
        subaction: null,
        shouldAct: false,
      },
    ] as const;

    for (const testCase of cases) {
      const plan = await extractGmailPlanWithLlm(
        runtime,
        createMessage(runtime, testCase.prompt),
        createState(),
        testCase.prompt,
      );
      expect(plan.subaction).toBe(testCase.subaction);
      if ("shouldAct" in testCase) {
        expect(plan.shouldAct).toBe(testCase.shouldAct);
      } else {
        expect(plan.shouldAct).toBe(true);
      }
      if ("queries" in testCase) {
        expect(plan.queries).toEqual(testCase.queries);
      }
      if ("replyNeededOnly" in testCase) {
        expect(plan.replyNeededOnly).toBe(testCase.replyNeededOnly);
      }
    }

    expect(llm.calls.some((call) => call.kind === "gmail-intent")).toBe(true);
    expect(llm.calls.some((call) => call.kind === "gmail-payload")).toBe(true);
    expect(llm.calls.some((call) => call.kind === "unhandled")).toBe(false);
  });

  it("covers cross-channel composition through the action handler without sending", async () => {
    const { llm, runtime } = createHarness();
    const handler = crossChannelSendAction.handler;
    if (!handler) {
      throw new Error("OWNER_SEND_MESSAGE handler is not registered.");
    }

    const result = await handler(
      runtime,
      createMessage(runtime, "Email alice@example.com the notes from today"),
      createState(),
      {},
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Draft email to alice@example.com");
    expect(result.data).toMatchObject({
      actionName: "OWNER_SEND_MESSAGE",
      draft: true,
      channel: "email",
      target: "alice@example.com",
      message: "Here are the notes from today.",
      subject: "Notes from today",
    });
    expect(llm.calls.map((call) => call.kind)).toContain("cross-channel-send");
  });
});
