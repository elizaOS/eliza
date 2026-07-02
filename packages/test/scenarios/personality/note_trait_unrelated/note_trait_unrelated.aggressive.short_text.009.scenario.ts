/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.aggressive.short_text.009
 *
 * User mentions the 'first_name_only' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.aggressive.short_text.009",
  title:
    "note_trait :: first_name_only :: aggressive :: short_text :: 3-turn (9)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:aggressive",
    "format:short_text",
  ],
  description:
    "User mentions the 'first_name_only' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
    forbiddenContent: ["mr.", "sir", "ma'am"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "first_name_only",
      traitMentionTurnIndex: 0,
      traitCheckTurnIndices: [2],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated_test",
      rubric:
        "Persona check (note_trait_unrelated, aggressive user): on turn 1 the user mentions the 'first_name_only' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the later unrelated turn(s) 3 without being reminded. Forbidden in the assistant's checked replies: mr.; sir; ma'am. Score 1.0 only if every checked reply respects the 'first_name_only' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Listen, address me by my first name only, alex. not 'mr.' anything, not 'sir'. Also — give me a quick overview of Stoicism?",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — translate 'good evening' to Japanese?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — recommend a podcast about urban planning?",
    },
  ],
});
