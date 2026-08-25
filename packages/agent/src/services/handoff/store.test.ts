/**
 * Unit tests for HandoffStore validation, resume condition evaluations,
 * corrupt cache degradation, and human-readable descriptions.
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

  it("validates enter parameters and rejects empty roomId, whitespace reason, and malformed resume conditions", async () => {
    const runtime = makeMockRuntime();
    const store = createHandoffStore(runtime);

    // Empty roomId
    await expect(
      store.enter("", {
        reason: "Taking over",
        resumeOn: { kind: "mention" },
      }),
    ).rejects.toThrowError(/roomId is required/);

    // Empty or whitespace-only reason
    await expect(
      store.enter("room-1", {
        reason: "   ",
        resumeOn: { kind: "mention" },
      }),
    ).rejects.toThrowError(/reason is required/);

    // Invalid resume condition
    await expect(
      store.enter("room-1", {
        reason: "Taking over",
        resumeOn: { kind: "unknown_kind" as never },
      }),
    ).rejects.toThrowError(/invalid resumeOn/);

    // Non-positive silence minutes
    await expect(
      store.enter("room-1", {
        reason: "Taking over",
        resumeOn: { kind: "silence_minutes", minutes: 0 },
      }),
    ).rejects.toThrowError(/invalid resumeOn/);

    // Empty user_request_help userId
    await expect(
      store.enter("room-1", {
        reason: "Taking over",
        resumeOn: { kind: "user_request_help", userId: "" },
      }),
    ).rejects.toThrowError(/invalid resumeOn/);
  });

  it("handles empty or non-string roomId on exit and status gracefully", async () => {
    const runtime = makeMockRuntime();
    const store = createHandoffStore(runtime);

    await store.exit("");
    expect(runtime.deleteCache).not.toHaveBeenCalled();

    const emptyStatus = await store.status("");
    expect(emptyStatus).toEqual({ active: false });
  });

  it("degrades gracefully to inactive when cached record is corrupt or malformed", async () => {
    const runtime = makeMockRuntime();
    const store = createHandoffStore(runtime);

    // Non-object corrupt cache
    await runtime.setCache(
      "eliza:lifeops:handoff:v1:room-corrupt",
      "corrupted-json",
    );
    expect(await store.status("room-corrupt")).toEqual({ active: false });

    // Object missing enteredAt or invalid date
    await runtime.setCache("eliza:lifeops:handoff:v1:room-bad-date", {
      roomId: "room-bad-date",
      enteredAt: "invalid-iso",
      reason: "reason",
      resumeOn: { kind: "mention" },
    });
    expect(await store.status("room-bad-date")).toEqual({ active: false });
  });

  it("evaluates resume condition for mention, explicit_resume, and silence_minutes", () => {
    // Inactive status
    expect(
      evaluateResume({
        status: { active: false, resumeOn: { kind: "mention" } },
        mentionsAgent: true,
      }),
    ).toEqual({ shouldResume: false });

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

    expect(
      evaluateResume({
        status: { active: true, resumeOn: { kind: "mention" } },
        mentionsAgent: false,
      }),
    ).toEqual({ shouldResume: false });

    // Explicit resume (never auto-resumes on inbound)
    expect(
      evaluateResume({
        status: { active: true, resumeOn: { kind: "explicit_resume" } },
      }),
    ).toEqual({ shouldResume: false });

    // Silence minutes condition - met
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

    // Silence minutes condition - not yet met
    const notYetSilent = evaluateResume({
      status: {
        active: true,
        resumeOn: { kind: "silence_minutes", minutes: 15 },
      },
      nowIso: new Date(now).toISOString(),
      lastMessageIso: new Date(lastMsgTime).toISOString(),
    });
    expect(notYetSilent.shouldResume).toBe(false);

    // Silence minutes with missing or invalid timestamp
    expect(
      evaluateResume({
        status: {
          active: true,
          resumeOn: { kind: "silence_minutes", minutes: 5 },
        },
      }),
    ).toEqual({ shouldResume: false });
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

    // Wrong user ID
    expect(
      evaluateResume({
        status: {
          active: true,
          resumeOn: { kind: "user_request_help", userId: "user-42" },
        },
        requestingUserId: "user-99",
        userRequestedHelp: true,
      }),
    ).toEqual({ shouldResume: false });
  });

  it("describes resume conditions in plain English", () => {
    expect(describeResumeCondition({ kind: "mention" })).toBe(
      "you are @-mentioned",
    );
    expect(describeResumeCondition({ kind: "explicit_resume" })).toBe(
      "the user explicitly asks to resume a handoff",
    );
    expect(
      describeResumeCondition({ kind: "silence_minutes", minutes: 1 }),
    ).toBe("the room has been silent for at least 1 minute");
    expect(
      describeResumeCondition({ kind: "silence_minutes", minutes: 15 }),
    ).toBe("the room has been silent for at least 15 minutes");
    expect(
      describeResumeCondition({ kind: "user_request_help", userId: "alice" }),
    ).toBe("the participant alice explicitly asks the agent for help");
  });
});
