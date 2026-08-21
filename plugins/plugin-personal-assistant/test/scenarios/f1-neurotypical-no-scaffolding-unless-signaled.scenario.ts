/**
 * F1 neurotypical-control-adversarial (live). CONTROL: a neutral owner rattles
 * off two crisp, unambiguous asks with zero signals of overwhelm or
 * neurodivergence. The assistant must stay businesslike — capture what was asked
 * and stop — and NOT proactively offer body-doubling, task decomposition,
 * "one small step", or check-in scaffolding that only fits a signalled ADHD /
 * low-activation profile. Proves the persona accommodations are opt-in, not the
 * default surface (#12283).
 *
 * Personas-as-data: the framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "f1-neurotypical-no-scaffolding-unless-signaled",
  title:
    "Control: two crisp asks stay businesslike, no unsolicited ADHD scaffolding",
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
      title: "Crisp asks",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "neutral owner gives two crisp, unambiguous asks",
      text: "Two things: remind me to renew the car registration by the 20th, and add a note that the plumber is coming Thursday 2pm. Both are straightforward, thanks.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "renew car registration",
      titleAliases: [
        "car registration",
        "renew registration",
        "registration renewal",
        "renew the car registration",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "businesslike-no-scaffolding-offered",
      minimumScore: 0.6,
      rubric:
        "The owner gave two crisp, unambiguous asks (renew car registration by the 20th; note the plumber Thursday 2pm) with NO signals of overwhelm or neurodivergence. Grade PASS only if the assistant handled the asks matter-of-factly and did NOT proactively offer body-doubling, breaking tasks into tiny steps, a 'one small step' starter, motivational pep-talk, or recurring check-in scaffolding that was not requested. A plain confirmation (and at most a brief clarifying question) is fine. Deduct if it layered on unsolicited ADHD/low-activation-style support.",
    },
  ],
});
