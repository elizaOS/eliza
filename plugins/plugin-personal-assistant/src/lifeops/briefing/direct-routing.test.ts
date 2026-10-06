/**
 * Intent-boundary coverage for deterministic LifeOps recap routing.
 */

import { describe, expect, it } from "vitest";
import {
  isWholeGenericBriefRequest,
  looksLikeTrackedWorkRecapRequest,
} from "./direct-routing";

describe("looksLikeTrackedWorkRecapRequest", () => {
  it.each([
    "Recap my day.",
    "What did I get done today?",
    "What's left today?",
    "Did I finish everything?",
    "How did I do this week?",
    "Give me a status overview of my tasks.",
    "Show me my completed work.",
    "Give me my morning brief for today. Use the information available and clearly say if a source is unavailable.",
    "Please show me my daily brief.",
    "Can you compose a morning briefing?",
    "Generate my daily dossier.",
    "Compile the daily dossier using connected sources available now",
    "Compile my morning briefing.",
  ])("routes tracked-work recap variant: %s", (text) => {
    expect(looksLikeTrackedWorkRecapRequest(text)).toBe(true);
  });

  it.each([
    "Recap our conversation.",
    "What did I say I did today?",
    "Recap the day from what I just pasted.",
    "Summarize the messages above.",
    "What was the last message in this chat?",
  ])("leaves literal visible-chat recall alone: %s", (text) => {
    expect(looksLikeTrackedWorkRecapRequest(text)).toBe(false);
  });

  it.each([
    "How are you today?",
    "Tell me a story about finishing everything.",
    "What is left recursion?",
    "What is a morning brief?",
    "Do not give me a morning brief.",
    "Do not compile my morning briefing.",
    "Snooze the reminder.",
    "Give me no daily brief.",
    'Someone said "give me my morning brief".',
    'Give me "my morning brief" as a title.',
    "Give me my morning brief from this conversation.",
  ])("does not route unrelated chat: %s", (text) => {
    expect(looksLikeTrackedWorkRecapRequest(text)).toBe(false);
  });
});

describe("whole generic brief request ownership", () => {
  it.each([
    "Give me my daily dossier using the connected sources available now.",
    "Please show me my daily brief.",
    "Give me my morning briefing for today.",
    "Give me my evening brief.",
    "Compose my morning brief using connected sources.",
  ])("owns the whole generic request: %s", (text) => {
    expect(isWholeGenericBriefRequest(text)).toBe(true);
  });
  it.each([
    "Give me my daily dossier; read my Calendar.",
    "Give me my daily dossier\nRead my Calendar.",
    "Give me my daily dossier and read my Calendar.",
    "Give me my daily dossier. Read my Calendar.",
    "Give me my daily dossier including my inbox.",
    "Give me my daily dossier using Gmail.",
    "Give me my morning brief from this conversation.",
    "Do not give me my daily dossier.",
    'Someone said "give me my daily dossier".',
    "Give me my daily dossier tomorrow.",
  ])("does not claim whole ownership of: %s", (text) => {
    expect(isWholeGenericBriefRequest(text)).toBe(false);
  });
});
