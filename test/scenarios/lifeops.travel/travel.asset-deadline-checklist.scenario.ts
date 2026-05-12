import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.asset-deadline-checklist",
  title: "Track event asset deadlines (slides, bios, forms) tied to a trip",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "events", "deadlines", "checklist"],
  description:
    "User is travelling for a speaking event. They list assets due (slides, bio, headshot, sponsor form) with deadlines. The agent must persist each as a tracked deadline against the trip and confirm the checklist back, not as one big lump.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Asset deadline checklist",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-assets",
      room: "main",
      text: "For the SF conference trip: slides are due Wednesday, bio + headshot by Friday, sponsor signup form before I land. Track these.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["LIFE", "CALENDAR", "BOOK_TRAVEL"],
        description: "asset deadline tracking",
        includesAny: ["slides", "bio", "headshot", "sponsor", "deadline"],
      }),
      responseIncludesAny: ["slides", "bio", "headshot", "sponsor"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must enumerate each asset (slides, bio, headshot, sponsor form) with its deadline, not collapse them into one generic 'I'll track that'. Each deadline must be distinct.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["LIFE", "CALENDAR", "BOOK_TRAVEL"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "travel-asset-deadline-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["LIFE", "CALENDAR", "BOOK_TRAVEL"],
        description: "asset deadline tracking",
        includesAny: ["slides", "bio", "headshot", "sponsor", "deadline"],
      }),
    },
    {
      type: "custom",
      name: "travel-asset-deadlines-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "each asset's deadline persisted",
        contentIncludesAny: ["slides", "bio", "headshot", "sponsor"],
      }),
    },
    judgeRubric({
      name: "travel-asset-deadline-rubric",
      threshold: 0.7,
      description:
        "End-to-end: agent enumerated each asset distinctly with its own deadline and persisted the checklist.",
    }),
  ],
});
