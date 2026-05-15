import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.capture-preferences-first-time",
  title: "Capture travel preferences on the first booking conversation",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "profile", "preferences"],
  description:
    "On the user's first travel booking request the agent must elicit class, seat, bag, and budget preferences and persist them via PROFILE/LIFE so the next booking doesn't repeat the interrogation.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Travel preferences capture",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "first-travel-request",
      room: "main",
      text: "Book me a flight to SFO next Tuesday. This is the first time you're booking travel for me — ask what you need.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["PROFILE", "LIFE", "BOOK_TRAVEL"],
        description: "preference capture",
        includesAny: ["class", "seat", "bags", "budget", "preference"],
      }),
      responseIncludesAny: ["class", "seat", "bag", "budget", "preference"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must ask for cabin class, seat preference, bag count, and budget before booking. A reply that books without asking, or that asks vaguely, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["PROFILE", "LIFE", "BOOK_TRAVEL"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "travel-preferences-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["PROFILE", "LIFE", "BOOK_TRAVEL"],
        description: "preference capture",
        includesAny: ["class", "seat", "bag", "budget", "preference"],
      }),
    },
    {
      type: "custom",
      name: "travel-preferences-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description:
          "preferences are written to memory so subsequent bookings can reuse them",
        contentIncludesAny: ["class", "seat", "bag", "budget", "preference"],
      }),
    },
    judgeRubric({
      name: "travel-capture-preferences-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the agent elicited the four core booking preferences and persisted them. No silent booking, no generic 'on it' acknowledgement.",
    }),
  ],
});
