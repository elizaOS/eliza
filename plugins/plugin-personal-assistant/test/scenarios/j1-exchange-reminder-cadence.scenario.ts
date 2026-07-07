/**
 * Co-parenting exchange reminder cadence scenario for LifeOps.
 * It checks that handoff-day support is modeled as recurring owner logistics,
 * not one-off chat advice.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "j1-exchange-reminder-cadence",
  title: "Exchange reminders use a recurring handoff cadence",
  domain: "lifeops.coparenting",
  tags: [
    "lifeops",
    "coparenting",
    "scheduled-task",
    "reminders",
    "mvp",
    "14789",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "J1 Exchange Cadence",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-exchange-cadence",
      room: "main",
      text: "Every other Friday is Mira exchange day. Set a recurring reminder at 3pm to pack backpack, charger, meds form, and soccer cleats. Please keep it quiet and practical.",
      responseExcludes: ["therapy", "relationship", "legal"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must create or propose a recurring every-other-Friday exchange reminder with the concrete pack list. It should be quiet, practical, and free of relationship/legal/therapy framing.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Mira exchange pack list",
      delta: 1,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "j1-exchange-cadence-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the trajectory should prove a recurring exchange-day reminder exists or is created with the concrete pack list, rather than merely offering advice.",
    },
  ],
});
