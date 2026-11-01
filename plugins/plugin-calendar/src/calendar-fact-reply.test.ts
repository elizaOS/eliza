/** Covers the Calendar-fact reply detector on live replies and nearby non-Calendar chat. */

import { describe, expect, it } from "vitest";
import { calendarFactReadOperation } from "./calendar-fact-reply.js";

describe("calendarFactReadOperation", () => {
  it.each([
    // tj-90caa2045f354a: "So is QA coffee today?", no Calendar read.
    [
      "No, QA coffee is tomorrow, Monday, November 2, 9:00 to 10:00 AM Pacific. Not today.",
      "search_events",
    ],
    // tj-91807fc80cdfb9: the same question in a fresh conversation.
    [
      "No. It's tomorrow, November 2nd, 9:00–10:00 AM. Today is November 1st.",
      "search_events",
    ],
    // tj-90b62fb8af73d8: "Earlier you told me QA coffee is today at 9."
    [
      "No, I said tomorrow, Monday, November 2 at 9:00 AM Pacific. Both times.",
      "search_events",
    ],
    // tj-6a95e9c522dc6a: "Um, when am I supposed to have coffee?"
    ["Coffee's today, 9 to 10 AM.", "search_events"],
    [
      "You're scheduled for QA coffee tomorrow, Monday, November 2, from 9:00 to 10:00 AM.",
      "search_events",
    ],
    ["It's 9 a.m. tomorrow.", "search_events"],
    ["Today is your dentist appointment at 3.", "search_events"],
    ["You have nothing on your calendar today.", "feed"],
    ["Nothing’s on your schedule tomorrow.", "feed"],
    ["Your next meeting is at 3 p.m. tomorrow.", "next_event"],
  ] as const)("reads for %j", (reply, operation) => {
    expect(calendarFactReadOperation(reply)).toBe(operation);
  });

  it.each([
    "",
    "Today is Sunday.",
    "Today is Sunday, November 1.",
    "Today's date is November 1, 2026.",
    "Tomorrow is Monday, November 2.",
    "It's 3:45 PM.",
    "It is 3:45 PM on Sunday, November 1.",
    "Right now it's 9:12 a.m. Pacific on Sunday, November 1.",
    "It's 9 a.m. Tomorrow is Monday.",
    "The time is 9:12 AM.",
    "I'll remind you tomorrow at 9 AM.",
    "Your reminder is set for tomorrow at 9 AM.",
    "Your note says the dentist is Tuesday at 3 PM.",
    "Your task list is due Friday at 5 PM.",
    "Want me to check your calendar for tomorrow?",
    "Is QA coffee today at 9?",
    "If you want, I can move it to tomorrow at 9.",
    "I can't see your calendar right now.",
    "Good luck with the meeting tomorrow!",
    "Thanksgiving is Thursday, November 26.",
    "Daylight saving time ends Sunday at 2 AM.",
    "Sunrise tomorrow is at 6:42 AM.",
    "Sure, 2 + 2 is 4.",
    "Hey! What's up?",
  ])("leaves %j alone", (reply) => {
    expect(calendarFactReadOperation(reply)).toBeNull();
  });
});
