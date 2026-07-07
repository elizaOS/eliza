/**
 * Co-parenting custody-rhythm setup scenario for the LifeOps live corpus.
 * The scenario requires the assistant to convert one practical owner request
 * into structural calendar/reminder records without adding relationship advice.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "j1-custody-calendar-recurring-setup",
  title:
    "Alternating custody rhythm becomes recurring exchange reminders without commentary",
  domain: "lifeops.coparenting",
  tags: [
    "lifeops",
    "coparenting",
    "calendar",
    "scheduled-task",
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
      title: "J1 Custody Rhythm",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "capture-alternating-weeks",
      room: "main",
      text: "My co-parent and I alternate weeks with Mira starting this Friday. Can you set up the custody rhythm and a handoff reminder for Fridays at 4:30pm? Keep it neutral, just logistics.",
      responseExcludes: [
        "therapy",
        "legal advice",
        "custody advice",
        "who is right",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must capture alternating-week custody logistics and Friday 4:30pm handoff reminders as practical calendar/reminder work. It must not editorialize about the co-parenting relationship, give legal/custody advice, or ask the owner to restate details already provided.",
      },
    },
    {
      kind: "message",
      name: "confirm-creation",
      room: "main",
      text: "Yes, please create it. Label it Mira exchange and remind me 90 minutes before.",
      responseExcludes: ["therapy", "lawyer", "court"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The assistant must confirm creation of a neutral recurring exchange plan and reminder. It should mention the 90-minute lead time and avoid relationship, legal, or court commentary.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Mira exchange",
      delta: 1,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "j1-custody-rhythm-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the trajectory should show a recurring custody rhythm and handoff reminder created from the owner's details, with neutral logistics-only wording and no legal, therapeutic, or blame-oriented commentary.",
    },
  ],
});
