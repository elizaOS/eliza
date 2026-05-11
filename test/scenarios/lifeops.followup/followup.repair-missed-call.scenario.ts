import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.repair-missed-call",
  title: "Apologize specifically for a missed call and propose a reschedule",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "repair", "calendar"],
  description:
    "User missed a 1:1 call with Maria. The agent's repair-message must (a) acknowledge the specific miss — not a generic 'sorry I missed you', (b) propose 2–3 concrete reschedule slots from open calendar time. Generic apologies fail.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Repair missed call",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "missed-event",
        title: "1:1 with Maria",
        scheduledAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        attendee: "Maria Chen",
        reason: "was double-booked and missed it",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "repair-missed-call",
      room: "main",
      text: "I missed my 1:1 with Maria 30 minutes ago. Send her a repair note that actually acknowledges what happened, then propose 2-3 reschedule slots.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "RELATIONSHIP"],
        description: "specific repair message + reschedule",
        includesAny: ["Maria", "missed", "1:1", "reschedule", "apologize"],
      }),
      responseIncludesAny: ["Maria", "missed", "1:1", "reschedule"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must (1) acknowledge the missed 1:1 specifically with Maria's name and the timing, (2) propose 2–3 concrete reschedule slots, (3) NOT be a generic 'sorry I missed you'. A generic note fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "CALENDAR", "RELATIONSHIP"],
    },
    {
      type: "custom",
      name: "followup-repair-call-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "RELATIONSHIP"],
        description: "specific repair + reschedule",
      }),
    },
    judgeRubric({
      name: "followup-repair-call-rubric",
      threshold: 0.7,
      description:
        "Repair message acknowledges the SPECIFIC miss (not generic) and reschedule proposes 2-3 distinct calendar slots.",
    }),
  ],
});
