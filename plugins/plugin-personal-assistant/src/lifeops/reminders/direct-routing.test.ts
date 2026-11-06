/**
 * Covers how the owner-reminder boundary reads polite request lead-ins.
 * OWNER_REMINDERS refuses a create whose message is a non-command context
 * (actions/owner-surfaces.ts), so a polite request must not read as a
 * question about reminders.
 */

import { describe, expect, it } from "vitest";
import {
  isOwnerReminderNonCommandContext,
  looksLikeOwnerReminderCreateRequest,
} from "./direct-routing";

describe("owner reminder polite request lead-ins", () => {
  it.each([
    "Is it possible to remind me at 6pm to call Dad?",
    "Is it possible for you to remind me tomorrow at 9 to pay rent?",
    "Would it be possible to remind me tomorrow at 9 to pay rent?",
    "Are you able to remind me tomorrow at 9 to pay rent?",
    "Are you able to please remind me at 6pm to call Dad?",
    "You know what, remind me to call the bank tomorrow at 9am",
    "You know what? Remind me to call the bank tomorrow at 9am.",
    "You know what, is it possible to remind me at 6pm to call Dad?",
  ])("reads a polite request as a reminder command: %s", (text) => {
    expect(isOwnerReminderNonCommandContext(text)).toBe(false);
    expect(looksLikeOwnerReminderCreateRequest(text)).toBe(true);
  });

  it.each([
    "Is remind me to call Pat a valid command?",
    "Are reminders synced to my phone?",
    "Is it possible to explain what remind me to call Pat does?",
    "Are you able to tell me how remind me to call Pat works?",
    "Do you know what remind me to call Pat means?",
    "You know what, can you explain how remind me to call Pat works?",
    "I want to know how the phrase remind me to call Pat tomorrow works.",
    "Is it possible to remind Pat at 6pm to call Dad?",
    "Is it possible to know what my reminders are?",
    "Is it possible to delete my reminder for tomorrow?",
    "Are you able to cancel the reminder to call Dad?",
    "Is it possible to see what reminders I have?",
  ])("keeps a question or third-party request non-command: %s", (text) => {
    expect(isOwnerReminderNonCommandContext(text)).toBe(true);
    expect(looksLikeOwnerReminderCreateRequest(text)).toBe(false);
  });
});
