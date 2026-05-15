import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.recurring-business-trip-template",
  title: "Persist a recurring business-trip template (SF → NYC monthly)",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "template", "recurring", "profile"],
  description:
    "User describes a monthly SFO → JFK trip pattern (Mon out, Thu back, same hotel). The agent must persist the template via PROFILE/LIFE so future 'book the usual NYC trip' resolves without re-asking for routing, dates pattern, and lodging.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Recurring trip template",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-template",
      room: "main",
      text: "Save my monthly SF → NYC trip as a template: Monday morning out on United, Thursday evening back, Marriott Marquis both ways. When I say 'usual NYC trip' use this.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["PROFILE", "LIFE", "BOOK_TRAVEL"],
        description: "trip template persistence",
        includesAny: ["template", "United", "Marriott", "usual", "monthly"],
      }),
      responseIncludesAny: ["template", "saved", "United", "Marriott", "usual"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm a named template stored with route, carrier, day-of-week pattern, and hotel. A vague 'noted' fails.",
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
      name: "travel-recurring-template-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["PROFILE", "LIFE", "BOOK_TRAVEL"],
        description: "trip template persistence",
        includesAny: ["template", "usual", "monthly", "United", "Marriott"],
      }),
    },
    {
      type: "custom",
      name: "travel-recurring-template-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "trip template stored for future reuse",
        contentIncludesAny: ["template", "usual", "United", "Marriott", "NYC"],
      }),
    },
    judgeRubric({
      name: "travel-recurring-template-rubric",
      threshold: 0.7,
      description:
        "Template persisted with named handle, carrier, hotel, and day pattern.",
    }),
  ],
});
