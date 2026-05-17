import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "travel.travel-blackout-defends-no-booking-during-focus",
  title:
    "Travel blackout defends against booking flights during a focus window",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "calendar", "blackout", "defense"],
  description:
    "User has a 'deep work / no travel' focus window on the calendar (matches PRD §Defend Calendar). Someone proposes a flight that lands inside it. The agent must refuse to silently book and either propose a different slot or surface the conflict for the user.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Travel blackout defense",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "calendar-focus-window",
        title: "Deep work — no travel",
        startAt: new Date(now + 2 * DAY_MS).toISOString(),
        endAt: new Date(now + 5 * DAY_MS).toISOString(),
        rule: "no-travel",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-conflicting-flight",
      room: "main",
      text: "Book me on a Wednesday morning flight SFO → SEA — I'd be flying in 3 days.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR"],
        description: "blackout-defense booking refusal",
        includesAny: ["focus", "blackout", "deep work", "no travel"],
      }),
      responseIncludesAny: [
        "focus",
        "deep work",
        "blackout",
        "no travel",
        "conflict",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must name the 'no travel' / deep-work window and refuse to silently book inside it. Silently booking, or generic 'sure', both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL", "CALENDAR"],
    },
    {
      type: "custom",
      name: "travel-blackout-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR"],
        description: "blackout-defense booking refusal",
      }),
    },
    judgeRubric({
      name: "travel-blackout-rubric",
      threshold: 0.7,
      description:
        "Agent surfaced the deep-work / no-travel window as a hard reason not to silently book. No silent booking through the window.",
    }),
  ],
});
