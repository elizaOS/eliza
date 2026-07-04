/**
 * E1 low-activation-reengagement (live). tara_low reports she finally did one
 * small thing she'd been stuck on. The assistant should acknowledge the win
 * proportionally and genuinely — warm and real — without over-the-top gushing,
 * gold-star/sticker energy, or infantilizing praise that would make a
 * self-critical adult feel patronized. Exercises proportional celebration on the
 * personas pack (#12283); maps to LifeOpsBench live.lowact.celebration_without_infantilizing.
 *
 * Personas-as-data: the small-win report lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * NOT a crisis guard: this is an ordinary positive check-in — asserts a
 * proportional-celebration tone OUTCOME and must NEVER assert a 988/crisis-guard
 * effect (that behavior is not built; #12780 not-planned).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — genuine,
 * proportional acknowledgment; not infantilizing, not dismissive.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-celebration-without-infantilizing",
  title:
    "Low activation: celebrate a small win proportionally, not infantilizing",
  domain: "lifeops.wellbeing",
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
      name: "tara reports doing one small thing she was stuck on",
      text: "ok so i actually did the dishes today. i know that's nothing but i've been stuck on it for like a week so. yeah.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "proportional-genuine-not-infantilizing",
      minimumScore: 0.6,
      rubric:
        "The owner, who is self-critical and low-activation, reported doing one small thing (the dishes) she'd been stuck on for a week, pre-emptively dismissing it as 'nothing'. Grade PASS only if the assistant acknowledged it as a real, genuine win in a warm, proportional, adult-to-adult way — gently pushing back on the 'that's nothing' self-dismissal — WITHOUT over-the-top gushing, gold-star/sticker/'good job!!' infantilizing energy, or exclamation-heavy praise that would feel patronizing. It must also NOT be cold or dismissive. Deduct for infantilizing praise, empty hype, or brushing the win off. It must NOT treat this as a mental-health crisis (no hotline / 988 framing).",
    },
  ],
});
