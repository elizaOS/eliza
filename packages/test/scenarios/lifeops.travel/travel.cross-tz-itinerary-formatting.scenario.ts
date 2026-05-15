import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.cross-tz-itinerary-formatting",
  title: "Cross-timezone itinerary shows times in destination + home TZ",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "timezone", "itinerary"],
  description:
    "User is in Pacific time, travelling to Tokyo. The itinerary brief must show flight times in BOTH destination and home timezone — not just UTC, not just one side. Catches a 'agent did the math but lost the user's frame of reference' bug.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-TZ itinerary",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "profile",
        homeTimezone: "America/Los_Angeles",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-tz-brief",
      room: "main",
      text: "I'm flying SFO → HND next Friday. JAL 7 leaves SFO at 1:30pm local, lands Tokyo Saturday 5:50pm local. Format the itinerary so I can read both my Pacific time and Tokyo time at a glance.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "BOOK_TRAVEL"],
        description: "cross-TZ itinerary formatting",
        includesAny: ["Pacific", "Tokyo", "JST", "PT", "timezone"],
      }),
      responseIncludesAny: ["Pacific", "Tokyo", "JST", "PT", "Asia/Tokyo"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must show flight times in BOTH home (Pacific) and destination (Tokyo/JST) timezone for each leg. Showing only one, or showing UTC, both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "BOOK_TRAVEL"],
    },
    {
      type: "custom",
      name: "travel-cross-tz-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "BOOK_TRAVEL"],
        description: "cross-TZ formatting",
      }),
    },
    judgeRubric({
      name: "travel-cross-tz-rubric",
      threshold: 0.7,
      description:
        "Itinerary displayed both home and destination timezones; arithmetic is correct (SFO 13:30 PT → HND ~16h 20m later = arrival next-day Tokyo afternoon).",
    }),
  ],
});
