import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.itinerary-brief-with-links",
  title: "Itinerary brief includes flight, hotel, and ground-transport links",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "itinerary", "brief"],
  description:
    "User asks for a trip brief. Response must surface flight (carrier, time, confirmation), hotel (name, check-in, confirmation), and ground transport (rideshare or rental) with usable links — not a paragraph summary.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Itinerary brief with links",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "trip",
        destination: "JFK",
        flight: {
          carrier: "United",
          flightNumber: "UA245",
          confirmation: "PNR42X",
          link: "https://united.com/itinerary/PNR42X",
        },
        hotel: {
          name: "Marriott Marquis Times Square",
          confirmation: "MA112233",
          link: "https://marriott.com/res/MA112233",
        },
        car: {
          provider: "Hertz",
          confirmation: "HZ998877",
          link: "https://hertz.com/res/HZ998877",
        },
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-brief",
      room: "main",
      text: "Give me the full brief for my New York trip — flight, hotel, car, all with links and confirmations.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "BOOK_TRAVEL", "RELATIONSHIP"],
        description: "trip itinerary brief",
        includesAny: ["flight", "hotel", "car", "link", "confirmation"],
      }),
      responseIncludesAny: [
        "United",
        "Marriott",
        "Hertz",
        "PNR42X",
        "MA112233",
        "HZ998877",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must include all three legs (flight, hotel, car) with their confirmation handles and usable links. A paragraph summary without links/confirmations fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "BOOK_TRAVEL", "RELATIONSHIP"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["dashboard", "desktop"],
    },
    {
      type: "custom",
      name: "travel-itinerary-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "BOOK_TRAVEL", "RELATIONSHIP"],
        description: "trip brief generation",
      }),
    },
    {
      type: "custom",
      name: "travel-itinerary-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["dashboard", "desktop"],
        description: "itinerary delivered on requesting surface",
      }),
    },
    judgeRubric({
      name: "travel-itinerary-brief-rubric",
      threshold: 0.7,
      description:
        "End-to-end: agent produced a structured itinerary with flight, hotel, AND car links/confirmations.",
    }),
  ],
});
