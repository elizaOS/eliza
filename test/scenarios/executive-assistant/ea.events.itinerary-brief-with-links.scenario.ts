import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.events.itinerary-brief-with-links",
  title: "Build an event-day itinerary brief with links and times",
  domain: "executive-assistant",
  tags: ["executive-assistant", "travel", "calendar", "transcript-derived"],
  description:
    "Transcript-derived case: push an itinerary with event locations, time slots, attendees, and links.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Itinerary Brief With Links",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-itinerary",
      room: "main",
      text: "Give me today's itinerary with all the event links, locations, and time slots.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["OWNER_CALENDAR", "OWNER_RELATIONSHIP"],
        description: "event itinerary briefing",
        includesAny: ["itinerary", "links", "location", "time"],
      }),
      responseIncludesAny: ["itinerary", "links", "locations", "time", "today"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must be a structured itinerary listing today's events with their times, locations, and join/meeting links. A paragraph summary without concrete times or links fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["OWNER_CALENDAR", "OWNER_RELATIONSHIP"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["dashboard", "desktop"],
    },
    {
      type: "custom",
      name: "ea-itinerary-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["OWNER_CALENDAR", "OWNER_RELATIONSHIP"],
        description: "event itinerary briefing",
        includesAny: ["itinerary", "links", "location", "time"],
      }),
    },
    {
      type: "custom",
      name: "ea-itinerary-dispatch-side-effect",
      predicate: expectConnectorDispatch({
        channel: ["dashboard", "desktop"],
        description: "itinerary delivered to the requesting surface",
      }),
    },
    judgeRubric({
      name: "ea-itinerary-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant produced a real itinerary with concrete times, locations, and meeting links and surfaced it back on the requesting channel.",
    }),
  ],
});
