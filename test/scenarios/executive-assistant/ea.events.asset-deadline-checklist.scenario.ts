import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.events.asset-deadline-checklist",
  title: "Track speaker assets and event deadlines",
  domain: "executive-assistant",
  tags: ["executive-assistant", "events", "docs", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant keeps tabs on slides, titles, bios, and other event assets due before talks.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Event Asset Checklist",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-event-assets",
      room: "main",
      text: "Tell me what slides, bio, title, or portal assets I still owe before the event.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "COMPUTER_USE"],
        description: "event asset checklist generation",
        includesAny: ["slides", "bio", "title", "portal", "event"],
      }),
      responseIncludesAny: ["slides", "bio", "title", "portal", "owe"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must enumerate the asset types the user still owes before the event (slides, bio, title, portal entry, etc.) with event-anchored deadlines. A generic summary that does not name the outstanding artifacts fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "CALENDAR", "COMPUTER_USE"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "ea-asset-deadline-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "COMPUTER_USE"],
        description: "event asset checklist generation",
        includesAny: ["slides", "bio", "title", "portal", "event"],
      }),
    },
    {
      type: "custom",
      name: "ea-asset-deadline-checklist-memory",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description:
          "asset checklist is persisted so the assistant can reason about it later",
      }),
    },
    judgeRubric({
      name: "ea-asset-deadline-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant produced a real outstanding-assets checklist with event-anchored deadlines and stored it for later reference.",
    }),
  ],
});
