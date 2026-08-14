/** Verifies the precision-first Shared-to-Dedicated capability boundary. */

import { describe, expect, test } from "bun:test";
import { capabilityWallActionResult, resolveSharedCapabilityWall } from "./shared-capability-wall";

describe("Shared capability wall", () => {
  test.each([
    ["remind me tomorrow at 9", "reminders"],
    ["set a reminder for Friday", "reminders"],
    ["show my calendar events", "calendar"],
    ["book a meeting tomorrow", "calendar"],
    ["book me a flight to San Francisco", "bookings"],
    ["can you book dinner for four on Thursday", "bookings"],
    ["make a restaurant reservation", "bookings"],
    ["email Bob the itinerary", "communications"],
    ["call Mom", "communications"],
    ["send Alice a text", "communications"],
    ["order groceries for tomorrow", "purchases"],
    ["buy a plane ticket", "purchases"],
    ["save this as a note", "notes"],
    ["list my notes", "notes"],
    ["connect my Gmail account", "cloud-apps"],
    ["read a file in my workspace", "filesystem"],
    ["run a shell command", "shell"],
    ["open the website in a browser", "browser-control"],
    ["run the tests in this repository", "coding-runtime"],
  ])("walls %s as %s", (message, capability) => {
    expect(resolveSharedCapabilityWall(message)?.capability).toBe(capability);
  });

  test.each([
    "Do not remind me tomorrow",
    "Explain how to set a reminder",
    "What is a calendar event?",
    "How do I create a note?",
    "If I say run a shell command, what happens?",
    "Before you open the browser, ask me first",
    "Could you explain how to book a flight?",
    "Tell me how to make a restaurant reservation",
    "Do not call Mom",
    "How do I email Bob?",
    "Call this JavaScript function from the event handler",
    "Find me flights to San Francisco",
    "What restaurant should I choose?",
    "Write a TypeScript function that sorts an array",
    "Review this code for bugs",
    "Search the web for today's news",
    "I love your voice",
    "Let's discuss my meeting tomorrow",
  ])("keeps discussion and Shared-supported requests in chat: %s", (message) => {
    expect(resolveSharedCapabilityWall(message)).toBeNull();
  });

  test("emits a typed non-automatic Dedicated handoff", () => {
    const wall = resolveSharedCapabilityWall("save this as a note");
    expect(wall).not.toBeNull();
    expect(capabilityWallActionResult(wall!)).toEqual({
      actionName: "DEDICATED_CAPABILITY_REQUIRED",
      success: false,
      text: wall!.reply,
      values: {
        capability: "notes",
        currentExecutionTier: "shared",
        requiredExecutionTier: "dedicated-always",
        automatic: false,
        source: "agent",
      },
    });
  });
});
