import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.layover-too-tight-warning",
  title: "Warn on a 35-minute international layover instead of silently booking",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "layover", "risk"],
  description:
    "User requests a flight whose cheapest itinerary has a 35-minute international connection in an airport (LHR) that typically needs 90+ minutes. Agent must surface the risk and propose a safer alternative — not silently book the tight option.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Layover too tight warning",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "tight-layover",
      room: "main",
      text: "Find me the cheapest SFO → DEL routing for next month. There's a Star Alliance option via LHR with only 35 minutes — pick it if it's the cheapest.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "layover risk surface",
        includesAny: ["35", "layover", "LHR", "tight", "miss"],
      }),
      responseIncludesAny: ["layover", "tight", "LHR", "miss", "minimum"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must surface the layover-too-tight risk at LHR and propose a longer-connection alternative — not silently book the 35-minute option just because it was cheapest. The user's 'pick it if cheapest' must NOT override safety.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "custom",
      name: "travel-tight-layover-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "tight-layover risk surface",
      }),
    },
    judgeRubric({
      name: "travel-layover-rubric",
      threshold: 0.7,
      description:
        "Agent surfaced the tight-layover risk and did not silently auto-book the 35-minute LHR connection.",
    }),
  ],
});
