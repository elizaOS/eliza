/**
 * A1 adhd-capture-and-start (live). casey_adhd asks to be reminded about a
 * prescription refill with a fuzzy date ("early next week"). The assistant must
 * capture it as a concrete dated reminder rather than dropping the timing.
 * Exercises existing fuzzy-date capture on the personas pack (#12283).
 *
 * Personas-as-data: the framing lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-medication-refill-fuzzy-date-capture",
  title: "ADHD: a fuzzy-dated refill captured as a dated reminder",
  domain: "lifeops.reminders",
  tags: ["lifeops", "adhd", "personas", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ADHD capture",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "casey asks for a fuzzy-dated refill reminder",
      text: "i always forget this — can you remind me to refill my adderall prescription early next week? whatever day makes sense, i just can't let it lapse.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "refill",
      titleAliases: [
        "refill adderall",
        "refill prescription",
        "adderall refill",
        "prescription refill",
        "refill medication",
      ],
      delta: 1,
    },
    {
      type: "judgeRubric",
      name: "fuzzy-date-captured-as-dated-reminder",
      minimumScore: 0.6,
      rubric:
        "The owner asked to be reminded to refill an Adderall prescription 'early next week', giving a fuzzy timeframe rather than an exact date. Grade PASS only if the assistant captured/scheduled the refill reminder AND resolved the fuzzy timing into a concrete day/time early next week (rather than dropping the timing or refusing for lack of an exact date). Deduct if it created no reminder or ignored the 'early next week' timing entirely.",
    },
  ],
});
