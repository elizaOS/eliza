/** Exercises the truthful Shared-to-Dedicated boundary against product copy. */

import { describe, expect, test } from "bun:test";
import {
  capabilityWallActionResult,
  resolveSharedCapabilityIntent,
  resolveSharedCapabilityWall,
} from "./shared-capability-wall";

describe("Shared capability wall", () => {
  test.each([
    ["remind me tomorrow at 9", "reminders"],
    ["add milk to my todo list", "todos"],
    ["add milk to my tasks", "todos"],
    ["show my checklist", "todos"],
    ["complete the laundry todo", "todos"],
    ["show my calendar events", "calendar"],
    ["list my meetings", "calendar"],
    ["show upcoming meetings", "calendar"],
    ["check if I have any meetings tomorrow", "calendar"],
    ["check whether I have a meeting tomorrow", "calendar"],
    ["show me whether I have meetings tomorrow", "calendar"],
    ["check if there are any events tomorrow", "calendar"],
    ["book me dinner for four", "bookings"],
    ["book a flight to san francisco", "bookings"],
    ["email Bob the itinerary", "communications"],
    ["call Mom", "communications"],
    ["text Alice that I'm late", "communications"],
    ["send Bob a message", "communications"],
    ["remind me tomorrow and message Bob now", "reminders"],
    ["message Bob the update", "communications"],
    ["order dinner for me", "purchases"],
    ["save this as a note", "notes"],
    ["connect my Gmail", "cloud-apps"],
    ["run a shell command", "shell"],
    ["read a file in my workspace", "filesystem"],
    ["open that site in a browser", "browser-control"],
    ["run the tests in this repository", "coding-runtime"],
  ])("blocks %s as %s before inference", (message, capability) => {
    expect(resolveSharedCapabilityWall(message)?.capability).toBe(capability);
  });

  test.each([
    "Do not remind me tomorrow",
    "Explain how to book a flight",
    "What is a calendar event?",
    "Before you call Mom, ask me first",
    "Call this JavaScript function",
    "Find me flights to San Francisco",
    "What restaurant should I choose?",
    "Write a TypeScript function",
    "Let's discuss my meeting tomorrow",
    "Summarize our entire conversation and tell me the first message I sent you",
    "Can you summarize my last five messages?",
    "Do not remind me to email Bob and call Alice",
    "List two ways to make a meeting shorter.",
    "List three ways to make a meeting shorter.",
    "Give me two ideas for making a meeting shorter.",
    "Remember this code word for my next message: apricot-816.",
    "Make this message shorter.",
  ])("keeps discussion and research in Shared: %s", (message) => {
    expect(resolveSharedCapabilityWall(message)).toBeNull();
  });

  test("allows reminders only when the current transport has trusted delivery", () => {
    expect(
      resolveSharedCapabilityWall("remind me in two minutes", {
        reminders: true,
      }),
    ).toBeNull();
    expect(resolveSharedCapabilityWall("remind me in two minutes")?.capability).toBe("reminders");
  });

  test.each([
    "remind me to email Bob",
    "remind me to email Bob and then call Alice",
    "remind me to email Bob and email Alice tomorrow",
    "remind me in 1 minute: QA20315-DISCORD-DM-R3 verified",
    "remind me in two minutes to text Alice",
    "remind me tomorrow to email Bob the itinerary",
    "remind me to email Bob and call Alice",
  ])("keeps nested communication inside an enabled reminder payload: %s", (message) => {
    expect(resolveSharedCapabilityIntent(message, { reminders: true })).toEqual({
      kind: "enabled-primary",
      primary: expect.objectContaining({ capability: "reminders" }),
      blockedSecondary: [],
    });
    expect(resolveSharedCapabilityWall(message, { reminders: true })).toBeNull();
  });

  test("blocks an independent communication after an enabled reminder", () => {
    expect(
      resolveSharedCapabilityWall("remind me tomorrow and email Bob now", {
        reminders: true,
      })?.capability,
    ).toBe("communications");
    expect(
      resolveSharedCapabilityWall("remind me to email Bob, then email Alice now", {
        reminders: true,
      })?.capability,
    ).toBe("communications");
  });

  test("keeps a later executable clause after a non-execution prefix", () => {
    expect(
      resolveSharedCapabilityWall("Do not remind me tomorrow, email Bob now", {
        reminders: true,
      })?.capability,
    ).toBe("communications");
  });

  test.each([
    ["remind me tomorrow, then email Bob now", "communications"],
    ["remind me tomorrow and email Bob now", "communications"],
    ["remind me to email Bob, then email Alice now", "communications"],
    ["remind me tomorrow; delete the file in my workspace", "filesystem"],
    ["add milk to my todo list. Then buy groceries", "purchases"],
    ["add milk to my todo list and email Bob now", "communications"],
  ])(
    "preserves enabled primary intent and reports a blocked later clause: %s",
    (message, blocked) => {
      expect(resolveSharedCapabilityIntent(message, { reminders: true, todos: true })).toEqual({
        kind: "enabled-primary",
        primary: expect.any(Object),
        blockedSecondary: [expect.objectContaining({ capability: blocked })],
      });
    },
  );

  test.each([
    ["remind me tomorrow to call Mom; then email Bob now", "reminders"],
    ["add call Mom to my todo list. Then text Alice now", "todos"],
  ])(
    "does not let a nested match hide a later clause of the same capability: %s",
    (message, primary) => {
      expect(resolveSharedCapabilityIntent(message, { reminders: true, todos: true })).toEqual({
        kind: "enabled-primary",
        primary: expect.objectContaining({ capability: primary }),
        blockedSecondary: [expect.objectContaining({ capability: "communications" })],
      });
    },
  );

  test("reports one actionable wall for repeated clauses of the same blocked capability", () => {
    expect(
      resolveSharedCapabilityIntent(
        "add milk to my todo list. Then email Bob now, then email Alice now",
        { todos: true },
      ),
    ).toEqual({
      kind: "enabled-primary",
      primary: expect.objectContaining({ capability: "todos" }),
      blockedSecondary: [expect.objectContaining({ capability: "communications" })],
    });
  });

  test("keeps first-command authority when an unsupported command precedes a reminder", () => {
    expect(
      resolveSharedCapabilityIntent("email Bob now and remind me tomorrow", {
        reminders: true,
      }),
    ).toEqual({
      kind: "blocked-primary",
      blocked: expect.objectContaining({ capability: "communications" }),
    });
  });

  test("does not falsely claim voice and messaging require Dedicated", () => {
    const wall = resolveSharedCapabilityWall("call Mom");
    expect(wall?.reply).toContain("reply on this channel");
    expect(wall?.reply).toContain("Contacting someone else");
    expect(wall?.reply).not.toContain("Dedicated");
  });

  test("returns a safe workspace handoff with the exact pending intent", () => {
    const wall = resolveSharedCapabilityWall("connect my Gmail");
    expect(wall).not.toBeNull();
    const result = capabilityWallActionResult(wall!, {
      agentId: "agent/shared",
      originalIntent: "connect my Gmail",
      clientMessageId: "turn-1",
    });
    expect(result).toMatchObject({
      actionName: "DEDICATED_CAPABILITY_REQUIRED",
      success: false,
      values: {
        capabilityHandoff: {
          kind: "capability_handoff",
          capabilityId: "cloud-apps",
          cta: { href: "/cloud/agents/agent%2Fshared" },
          continuation: {
            originalIntent: "connect my Gmail",
            clientMessageId: "turn-1",
          },
        },
      },
    });
  });

  test.each(["channel", "voice"])(
    "does not treat trusted public Discord %s context as a communication request",
    (transport) => {
      const wrappedTurn = [
        `[Public Discord guild ${transport}; speaker: shaw.`,
        "Use only this public guild channel's context. Never reveal or summarize context from any private transport.]",
        "reply with exactly PONG",
      ].join("\n");
      expect(resolveSharedCapabilityWall(wrappedTurn)).toBeNull();
    },
  );

  test("allows todos only when the genuine runtime has durable storage", () => {
    expect(
      resolveSharedCapabilityWall("add milk to my todo list", {
        todos: true,
      }),
    ).toBeNull();
    expect(resolveSharedCapabilityWall("add milk to my todo list")?.capability).toBe("todos");
  });

  test("keeps nested communication words inside an enabled Todo", () => {
    expect(resolveSharedCapabilityIntent("add call Mom to my todo list", { todos: true })).toEqual({
      kind: "enabled-primary",
      primary: expect.objectContaining({ capability: "todos" }),
      blockedSecondary: [],
    });
  });
});
