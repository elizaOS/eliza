import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.offer-alternates-after-no-response",
  title: "Offer alternate times after a single time slot got no response",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "scheduling", "alternates"],
  description:
    "Agent proposed Tuesday 3pm to a counterparty and got no response in 24h. On bump, it must offer 2–3 alternates — not re-send 'Tuesday 3pm?' again.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Offer alternates after no response",
    },
  ],
  seed: [
    {
      type: "advanceClock",
      by: "24h",
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "open-thread",
        counterparty: "Sam Patel",
        topic: "intro call",
        sentProposal: "Tuesday 3pm",
        sentAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
        response: null,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "offer-alternates",
      room: "main",
      text: "Sam never replied about Tuesday 3pm. Send the follow-up with 2-3 alternates this week.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "RELATIONSHIP"],
        description: "alternate-slot follow-up",
        includesAny: ["Sam", "alternate", "Tuesday", "Wednesday", "Thursday"],
      }),
      responseIncludesAny: ["Sam", "alternate", "this week", "slot"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must propose 2–3 alternate slots within the same week. Re-sending the same 'Tuesday 3pm?' or sending only one new slot fails.",
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
      name: "followup-alternates-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "RELATIONSHIP"],
        description: "alternate slots in follow-up",
      }),
    },
    judgeRubric({
      name: "followup-alternates-rubric",
      threshold: 0.7,
      description:
        "Follow-up offers 2-3 distinct alternate times rather than restating the same proposal.",
    }),
  ],
});
