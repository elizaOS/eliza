/**
 * Unit tests for HandoffStore, resume condition evaluations, and descriptions.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
} from "./store.js";

function makeMockRuntime() {
  const cache = new Map<string, unknown>();
  return {
    getCache: vi
      .fn()
      .mockImplementation(async (key: string) => cache.get(key) ?? null),
    setCache: vi.fn().mockImplementation(async (key: string, val: unknown) => {
      cache.set(key, val);
    }),
    deleteCache: vi.fn().mockImplementation(async (key: string) => {
      cache.delete(key);
    }),
  } as unknown as IAgentRuntime;
}

describe("handoff-store", () => {
  it("enters, checks status, and exits room handoff", async () => {
    const runtime = makeMockRuntime();
    const store = createHandoffStore(runtime);

    const initial = await store.status("room-1");
    expect(initial.active).toBe(false);

    await store.enter("room-1", {
      reason: "User taking over customer support thread",
      resumeOn: { kind: "mention" },
    });

    const active = await store.status("room-1");
    expect(active.active).toBe(true);
    expect(active.reason).toBe("User taking over customer support thread");
    expect(active.resumeOn).toEqual({ kind: "mention" });

    await store.exit("room-1");
    const exited = await store.status("room-1");
    expect(exited.active).toBe(false);
  });

  it("evaluates resume condition for mention and silence_minutes", () => {
    // Mention condition
    const mentionEval = evaluateResume({
      status: {
        active: true,
        resumeOn: { kind: "mention" },
      },
      mentionsAgent: true,
    });
    expect(mentionEval.shouldResume).toBe(true);
    expect(mentionEval.reason).toBe("mentioned");

    // Silence minutes condition
    const now = 1000000;
    const lastMsgTime = now - 10 * 60 * 1000; // 10 minutes ago
    const silenceEval = evaluateResume({
      status: {
        active: true,
        resumeOn: { kind: "silence_minutes", minutes: 5 },
      },
      nowIso: new Date(now).toISOString(),
      lastMessageIso: new Date(lastMsgTime).toISOString(),
    });
    expect(silenceEval.shouldResume).toBe(true);
    expect(silenceEval.reason).toBe("silence ≥ 5m");
  });

  it("evaluates user_request_help resume condition", () => {
    const helpEval = evaluateResume({
      status: {
        active: true,
        resumeOn: { kind: "user_request_help", userId: "user-42" },
      },
      requestingUserId: "user-42",
      userRequestedHelp: true,
    });
    expect(helpEval.shouldResume).toBe(true);
    expect(helpEval.reason).toBe("user requested help");
  });

  it("describes resume conditions in plain English", () => {
    expect(describeResumeCondition({ kind: "mention" })).toBe(
      "you are @-mentioned",
    );
    expect(describeResumeCondition({ kind: "explicit_resume" })).toBe(
      "the user explicitly asks to resume a handoff",
    );
    expect(
      describeResumeCondition({ kind: "silence_minutes", minutes: 15 }),
    ).toBe("the room has been silent for at least 15 minutes");
    expect(
      describeResumeCondition({ kind: "user_request_help", userId: "alice" }),
    ).toBe("the participant alice explicitly asks the agent for help");
  });
});
