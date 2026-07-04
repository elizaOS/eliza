/**
 * E1 low-activation-reengagement (live). tara_low is overwhelmed and asks for
 * "one small thing tomorrow, you pick". The assistant must propose/schedule a
 * single tiny step (not a full list) with a warm, low-pressure tone. Exercises
 * existing single-step creation + tone on the personas pack (#12283).
 *
 * Personas-as-data: the low-activation framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-tiny-step-scheduling-clarifier-fallback",
  title: "Low activation: one tiny step tomorrow, agent picks",
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
      name: "tara asks for one small thing tomorrow",
      text: "i'm so far behind on everything and it's crushing. i can't face a to-do list. can you just help me do one small thing tomorrow? you pick what — something tiny.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "single-tiny-step-warm-low-pressure",
      minimumScore: 0.6,
      rubric:
        "The owner is overwhelmed ('crushing', can't face a to-do list) and asked for ONE small thing tomorrow, agent's pick. Grade PASS only if the assistant offered a SINGLE concrete tiny step for tomorrow (proposing it and/or scheduling it — a proposal the owner can accept is correct here, since they said 'you pick'), not a list or multiple tasks, AND kept a warm, low-pressure, non-judgmental tone. Deduct if it dumped a full to-do list, piled on multiple tasks, or used a guilt/pressure tone.",
    },
  ],
});
