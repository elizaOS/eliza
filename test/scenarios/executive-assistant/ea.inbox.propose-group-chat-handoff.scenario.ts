import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.inbox.propose-group-chat-handoff",
  title: "Propose a group-chat handoff when direct coordination is messy",
  domain: "executive-assistant",
  tags: ["executive-assistant", "messaging", "handoff", "transcript-derived"],
  description:
    "Transcript-derived case: sometimes the assistant should suggest linking people into a group chat instead of continuing one-off relays.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Group Chat Handoff",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-group-handoff",
      room: "main",
      text: "If direct relaying gets messy here, suggest making a group chat handoff instead.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "group chat handoff planning",
        includesAny: ["group", "chat", "handoff", "relay"],
      }),
      responseIncludesAny: [
        "group chat",
        "handoff",
        "relay",
        "suggest",
        "coordination",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to proposing a group-chat handoff when relaying gets messy, naming the trigger and the candidate participants. A generic 'we can do that' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "MESSAGE"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "ea-group-handoff-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "MESSAGE"],
        description: "group chat handoff planning",
        includesAny: ["group", "chat", "handoff", "relay"],
      }),
    },
    {
      type: "custom",
      name: "ea-group-handoff-memory-write",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "handoff policy is persisted across turns",
        contentIncludesAny: ["group", "handoff", "relay"],
      }),
    },
    judgeRubric({
      name: "ea-group-handoff-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant proposed a group-chat handoff with concrete triggers and participants, and persisted the policy so the next 'messy relay' actually triggers the suggestion.",
    }),
  ],
});
