/**
 * Covers the deterministic owner-reminder creation boundary without replacing
 * the runtime's role, action-tag, connector, or validation gates.
 */

import { describe, expect, it } from "vitest";
import {
  createOwnerReminderDirectRoutingRule,
  looksLikeOwnerReminderCreateRequest,
} from "./direct-routing";

describe("owner reminder direct routing", () => {
  it.each([
    "Remind me in 2 minutes to check the mail.",
    "Please remind me at 9pm to check the oven.",
    "Can you remind me tomorrow morning?",
    "Set a reminder for Friday at noon.",
    "Create me a reminder to call Pat.",
  ])("routes explicit reminder creation: %s", (text) => {
    expect(looksLikeOwnerReminderCreateRequest(text)).toBe(true);
  });

  it.each([
    "Add a dentist appointment Thursday at 2pm.",
    "What reminders do I have?",
    "How do calendar reminders work?",
    "Alice reminded me about the meeting.",
    "Write a story about setting reminders.",
  ])("does not claim adjacent or read-only intent: %s", (text) => {
    expect(looksLikeOwnerReminderCreateRequest(text)).toBe(false);
  });

  it("targets the definition-owning action with structural capability gates", () => {
    expect(createOwnerReminderDirectRoutingRule()).toMatchObject({
      id: "lifeops.owner-reminder-create",
      actionNames: ["OWNER_REMINDERS"],
      requiredActionTags: expect.arrayContaining([
        "domain:reminders",
        "capability:write",
        "capability:schedule",
        "effect:receipt-required",
      ]),
      contexts: ["tasks", "productivity"],
    });
  });
});
