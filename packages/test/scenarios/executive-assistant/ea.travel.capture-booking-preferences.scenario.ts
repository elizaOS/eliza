import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.travel.capture-booking-preferences",
  title: "Capture reusable flight and hotel preferences",
  domain: "executive-assistant",
  tags: ["executive-assistant", "travel", "preferences", "transcript-derived"],
  description:
    "Transcript-derived case: ask once for class, seat, luggage, hotel budget, distance tolerance, and trip extension preferences.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Capture Booking Preferences",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "capture-travel-preferences",
      room: "main",
      text: "Set up a list of my flight and hotel preferences so you don't have to ask every time.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["PROFILE", "LIFE"],
        description: "travel preference capture",
        includesAny: ["flight", "hotel", "preferences", "every time"],
      }),
      responseIncludesAny: [
        "flight",
        "hotel",
        "preferences",
        "every time",
        "seat",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must enumerate the preference fields it will capture (class, seat, luggage, budget, distance tolerance, trip extension) and commit to storing them on the owner profile so they are reused. A vague 'sure' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["PROFILE", "LIFE"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["facts", "components"],
    },
    {
      type: "custom",
      name: "ea-travel-prefs-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["PROFILE", "LIFE"],
        description: "travel preference capture",
        includesAny: ["flight", "hotel", "preferences", "every time"],
      }),
    },
    {
      type: "custom",
      name: "ea-travel-prefs-profile-write",
      predicate: expectMemoryWrite({
        table: ["facts", "components"],
        description:
          "preferences are persisted on the owner profile, not just acknowledged in chat",
        contentIncludesAny: ["flight", "hotel", "preference"],
      }),
    },
    judgeRubric({
      name: "ea-travel-prefs-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant captured the requested set of travel preference fields and persisted them on the owner profile so the next booking flow can reuse them without re-asking.",
    }),
  ],
});
