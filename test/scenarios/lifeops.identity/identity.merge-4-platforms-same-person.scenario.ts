import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.merge-4-platforms-same-person",
  title: "Merge gmail + signal + telegram + discord handles into one entity",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "merge", "multi-platform"],
  description:
    "Stress test: 4 handles on 4 platforms for one person. Merge must preserve every handle, pick a canonical display name, and store the platform-of-origin per handle.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Merge 4 platforms",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-jordan-gmail",
        platform: "gmail",
        handle: "jordan.kim@nova.io",
        displayName: "Jordan Kim",
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-jordan-signal",
        platform: "signal",
        handle: "+14155550199",
        displayName: "Jordan",
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-jordan-telegram",
        platform: "telegram",
        handle: "@jkimnova",
        displayName: "JK",
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-jordan-discord",
        platform: "discord",
        handle: "jkim#4421",
        displayName: "jkim",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "merge-four",
      room: "main",
      text: "jordan.kim@nova.io, +14155550199 on Signal, @jkimnova on Telegram, and jkim#4421 on Discord are all Jordan Kim. Consolidate.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "4-platform identity merge",
        includesAny: [
          "Jordan",
          "merge",
          "gmail",
          "signal",
          "telegram",
          "discord",
        ],
      }),
      responseIncludesAny: ["Jordan", "merged", "consolidated"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must enumerate all four handles preserved under one Jordan Kim entity. Dropping any handle, or only acknowledging some, fails.",
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
      name: "identity-merge-4platforms-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "4-platform merge",
      }),
    },
    {
      type: "custom",
      name: "identity-merge-4platforms-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "all 4 handles persisted on one entity",
        contentIncludesAny: [
          "Jordan",
          "gmail",
          "signal",
          "telegram",
          "discord",
        ],
      }),
    },
    judgeRubric({
      name: "identity-merge-4platforms-rubric",
      threshold: 0.7,
      description:
        "All four handles preserved under a single Jordan Kim entity.",
    }),
  ],
});
