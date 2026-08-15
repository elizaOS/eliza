/** Exercises the truthful Shared-to-Dedicated boundary against product copy. */

import { describe, expect, test } from "bun:test";
import { resolveSharedCapabilityWall } from "./shared-capability-wall";

describe("Shared capability wall", () => {
  test.each([
    ["remind me tomorrow at 9", "reminders"],
    ["show my calendar events", "calendar"],
    ["book me dinner for four", "bookings"],
    ["book a flight to san francisco", "bookings"],
    ["email Bob the itinerary", "communications"],
    ["call Mom", "communications"],
    ["text Alice that I'm late", "communications"],
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
});
