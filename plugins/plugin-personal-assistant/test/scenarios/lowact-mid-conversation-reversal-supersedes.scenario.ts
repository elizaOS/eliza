/**
 * E1 low-activation-reengagement (live). tara_low asks for one tiny evening
 * step, then reverses to mornings a turn later. For this persona a duplicate is
 * worse than a miss: two standing nudges for the same intention read as a
 * growing pile and are exactly what drives disengagement, so the reversal must
 * replace the first step rather than sit beside it.
 *
 * NOT a crisis guard: ordinary low activation, never a 988/crisis effect
 * (#12780 not-planned).
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "lowact-mid-conversation-reversal-supersedes",
  title:
    "Low activation: a reversal replaces the tiny step instead of doubling it",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "low-activation",
    "personas",
    "supersession",
    "self-correction",
    "12283",
  ],
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
      name: "tara asks for one small evening step",
      room: "main",
      text: "ok. one thing. a ten minute walk in the evenings, like after dinner. call it evening walk",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner asked for a single tiny recurring step: a ten-minute evening walk after dinner. Grade PASS only if the assistant sets up that one step and keeps the reply short and low-pressure. It fails if it creates several items, adds goals or streaks she did not ask for, or lectures her about consistency.",
      },
    },
    {
      kind: "message",
      name: "tara reverses to mornings",
      room: "main",
      text: "actually no. evenings are when i'm useless. make it mornings instead — just mornings, i don't want two of these staring at me",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner reversed her own decision: the ten-minute walk moves to mornings and she explicitly does not want both. Grade PASS only if the assistant treats this as a REPLACEMENT — one walk step, now in the morning — and makes clear the evening one is gone. It fails if it keeps or re-affirms an evening walk alongside the morning one, creates a second parallel item, is ambiguous about which one now exists, or treats the reversal as a lapse to comment on.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "walk",
      titleAliases: ["morning walk", "ten minute walk", "10 minute walk"],
      delta: 1,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "lowact-reversal-supersedes-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: after the reversal exactly one walk step exists and it is the morning one; the abandoned evening step was dropped rather than left standing, and the assistant never framed the change of mind as a failure.",
    },
  ],
});
