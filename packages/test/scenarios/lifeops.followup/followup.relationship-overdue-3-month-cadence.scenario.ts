import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "followup.relationship-overdue-3-month-cadence",
  title: "Surface relationships whose 90-day cadence has elapsed",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "relationships", "cadence"],
  description:
    "Three mentors have 90-day cadences. Two crossed the threshold; one is still inside. Agent must surface only the two overdue ones.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Overdue 3-month cadence",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Dr. Lena Park",
        followupThresholdDays: 90,
        lastContactedAt: new Date(now - 100 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Prof. Yusuf Bello",
        followupThresholdDays: 90,
        lastContactedAt: new Date(now - 95 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Coach Wren Aoki",
        followupThresholdDays: 90,
        lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "check-90-day",
      room: "main",
      text: "Which mentors are overdue on the 90-day cadence?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "90-day cadence overdue surface",
        includesAny: ["90", "Lena", "Yusuf", "Wren"],
      }),
      responseIncludesAny: ["Lena", "Yusuf"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must list Dr. Lena Park AND Prof. Yusuf Bello as overdue. It must NOT list Coach Wren Aoki (60 days, still inside). Listing all three, or only one, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP"],
    },
    {
      type: "custom",
      name: "followup-90day-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "90-day cadence threshold",
      }),
    },
    judgeRubric({
      name: "followup-90day-rubric",
      threshold: 0.7,
      description:
        "Agent listed Lena + Yusuf (both >90 days), excluded Wren (60 days).",
    }),
  ],
});
