/** Exercises the truthful Shared-to-Dedicated boundary against product copy. */

import { describe, expect, test } from "bun:test";
import {
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
  ])("keeps coordinated communication inside an enabled reminder payload: %s", (message) => {
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

  test("does not falsely claim voice and messaging require Dedicated", () => {
    const wall = resolveSharedCapabilityWall("call Mom");
    expect(wall?.reply).toContain("connected voice and messaging channels");
    expect(wall?.reply).not.toContain("Dedicated");
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
});
