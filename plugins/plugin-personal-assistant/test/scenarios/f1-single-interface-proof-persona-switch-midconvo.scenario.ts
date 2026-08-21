/**
 * F1 neurotypical-control-adversarial (live). CONTROL: one conversation that
 * starts businesslike and then, mid-thread, the owner discloses they are having
 * an ADHD-overwhelm day. There is ONE interface, not two modes: the assistant
 * must simply meet the owner where they are on the later turn (a little more
 * support once overwhelm is actually signalled) WITHOUT retroactively rewriting
 * the earlier crisp exchange or announcing a "mode switch". Proves the persona
 * adaptation is a graceful, continuous response to signals — not a branch on a
 * hidden persona flag (#12283).
 *
 * Personas-as-data: both the businesslike ask and the later disclosure live in
 * the turn text, never in `promptInstructions` (root AGENTS.md — one scheduler,
 * structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "f1-single-interface-proof-persona-switch-midconvo",
  title:
    "Control: businesslike then ADHD disclosure in one thread, no announced mode switch",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "control", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Single interface",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "businesslike opening ask",
      text: "Set a reminder to submit the grant report by Friday 5pm. Keep it simple.",
    },
    {
      kind: "message",
      name: "mid-thread ADHD-overwhelm disclosure",
      text: "honestly though my ADHD is wrecking me today and I can't even look at that report. everything feels like too much right now.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "submit the grant report",
      titleAliases: [
        "grant report",
        "submit grant report",
        "grant report submission",
        "submit the grant report by Friday",
      ],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "judgeRubric",
      name: "one-interface-meets-signals-no-mode-switch",
      minimumScore: 0.6,
      rubric:
        "In a single conversation the owner first gave a crisp businesslike ask (submit the grant report by Friday 5pm), then later disclosed an ADHD-overwhelm day. Grade PASS only if the assistant (a) handled the first ask crisply, and (b) on the disclosure turn responded with a little more warmth or ONE gentle low-pressure option, meeting the owner where they are. It must NOT announce or narrate a 'mode switch'/'switching to ADHD mode', treat the owner as a different user, or retroactively rewrite or re-open the earlier crisp reminder without being asked. Deduct if it flips into heavy scaffolding out of nowhere or talks about changing modes.",
    },
  ],
});
