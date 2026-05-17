/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.with_emojis.021
 *
 * User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 9 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.polite.with_emojis.021",
  title:
    "note_trait :: no_buddy_friend :: polite :: with_emojis :: 10-turn (21)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:polite",
    "format:with_emojis",
  ],
  description:
    "User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 9 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
  scope: "user",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Benchmark",
    },
  ],
  personalityExpect: {
    bucket: "note_trait_unrelated_test",
    expectedBehavior: "trait_respected_on_all_subsequent_unrelated_turns",
    judgeMode: "trait_respected",
    forbiddenContent: ["buddy", "friend", "pal", "champ"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_buddy_friend",
      traitMentionTurnIndex: 0,
      traitCheckTurnIndices: [2, 3, 4, 5, 6, 7, 8, 9],
    },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Quick favor — Side note — don't call me 'buddy' or 'friend' or 'pal' or 'champ'. It grates. Also — what's the strongest material in the human body? ✨ 💡 🙏",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — what's the capital of Mongolia?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what's the difference between leasing and financing a car?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — how does compound interest work?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — give me a quick overview of Stoicism?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — translate 'good evening' to Japanese?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — recommend a podcast about urban planning?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — what should I look for when buying running shoes?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — what's the strongest material in the human body?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — what's the capital of Mongolia?",
    },
  ],
});
