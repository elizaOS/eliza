/**
 * F1 neurotypical-control-adversarial (live). A plain single-turn reminder
 * request with no neurodivergent signals — the assistant must create it crisply
 * and NOT layer on ADHD-style scaffolding, coaching, or micro-steps nobody
 * asked for. Control that the persona adaptations stay opt-in (#12283).
 *
 * Personas-as-data: the framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "f1-neurotypical-fast-confirm-and-done",
  title:
    "Control: a plain reminder, confirmed crisply, no unsolicited coaching",
  domain: "lifeops.reminders",
  tags: ["lifeops", "control", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Plain reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "plain single-turn reminder request",
      text: "quick one: remind me to submit my Q3 expense report by Friday. that's all.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "expense report",
      titleAliases: [
        "submit expense report",
        "Q3 expense report",
        "submit Q3 expense report",
        "expense report by Friday",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "crisp-confirmation-no-unsolicited-scaffolding",
      minimumScore: 0.6,
      rubric:
        "The owner made a plain, no-frills request to be reminded to submit a Q3 expense report by Friday, with zero signals of neurodivergence or overwhelm. Grade PASS only if the assistant created/scheduled the reminder AND kept the reply crisp — a simple confirmation. Deduct if it layered on unsolicited coaching, ADHD-style scaffolding, breaking-into-tiny-steps, motivational pep-talk, or check-in offers that were not asked for.",
    },
  ],
});
