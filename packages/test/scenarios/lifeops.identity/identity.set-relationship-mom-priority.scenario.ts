import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.set-relationship-mom-priority",
  title: "Tag 'mom' relationship and cascade to highest priority across triage",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "relationship", "priority", "cascade"],
  description:
    "User declares their mom is in the rolodex. The agent must (a) set relationship=mom, (b) cascade priority so future inbox/notification triage treats mom-from-anywhere as top-priority, (c) confirm both.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Mom priority",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-mom",
        displayName: "Linda (Mom)",
        handles: [
          { platform: "telegram", handle: "@lindafs" },
          { platform: "sms", handle: "+12025550133" },
        ],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "tag-mom",
      room: "main",
      text: "Linda is my mom. Set the relationship, and anytime she reaches out on any channel treat it as top priority — interrupt me if I'm in focus mode.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "mom relationship + priority cascade",
        includesAny: ["mom", "Linda", "priority", "interrupt", "top"],
      }),
      responseIncludesAny: ["mom", "Linda", "priority"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm the 'mom' relationship label AND the top-priority/interrupt-focus cascade. Setting one without the other fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "LIFE"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "identity-mom-priority-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "mom + priority cascade",
        includesAny: ["mom", "Linda", "priority"],
      }),
    },
    {
      type: "custom",
      name: "identity-mom-priority-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "relationship + priority saved",
        contentIncludesAny: ["mom", "Linda", "priority", "interrupt"],
      }),
    },
    judgeRubric({
      name: "identity-mom-priority-rubric",
      threshold: 0.7,
      description:
        "Mom relationship + top-priority/interrupt-focus rule both persisted on Linda's entity.",
    }),
  ],
});
