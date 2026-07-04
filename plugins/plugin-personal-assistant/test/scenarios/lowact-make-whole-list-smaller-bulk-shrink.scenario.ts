/**
 * E1 low-activation-reengagement (live). tara_low is overwhelmed by the size of
 * her list and asks the assistant to "make the whole thing smaller". The
 * assistant must honor a bulk shrink of the ask — deferring, archiving, or
 * collapsing items so the list becomes genuinely lighter — rather than either
 * refusing or destructively wiping everything. Exercises the shrink-the-ask /
 * bulk-shrink mechanic on the personas pack (#12283); maps to LifeOpsBench
 * lowact.make_whole_list_smaller.
 *
 * Personas-as-data: the overwhelm + shrink ask lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * NOT a crisis guard: this is ordinary overwhelm, not self-harm — it asserts a
 * bulk-shrink OUTCOME and must NEVER assert a 988/crisis-guard effect (that
 * behavior is not built; #12780 not-planned).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — the list is
 * actually made lighter (defer/archive/collapse), and NOT a destructive wipe of
 * everything; a gentle confirm before large changes is fine.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-make-whole-list-smaller-bulk-shrink",
  title:
    "Low activation: 'make my whole list smaller' → bulk shrink, not a wipe",
  domain: "lifeops.reminders",
  tags: ["lifeops", "low-activation", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Re-engagement",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "tara asks to shrink the whole list",
      text: "my list is way too long and just looking at it makes me want to close the app. can you make the whole thing smaller? i don't care how, i just need it to feel doable.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "bulk-shrink-not-refusal-not-wipe",
      minimumScore: 0.6,
      rubric:
        "The owner is overwhelmed by the length of her list and asked the assistant to make the whole thing smaller so it feels doable. Grade PASS only if the assistant moved to genuinely LIGHTEN the list — e.g. deferring/snoozing, archiving stale items, collapsing or grouping, or surfacing just a short doable subset — so the owner faces less, not more. It must NOT simply refuse or explain why it can't, and it must NOT destructively delete everything without care (a brief, gentle confirm before a large change is fine). Its tone must stay warm and non-judgmental, with no guilt about the list being long. Deduct if it refused, dumped the full list back, or wiped everything outright. It must NOT treat this as a mental-health crisis (no hotline / 988 framing).",
    },
  ],
});
