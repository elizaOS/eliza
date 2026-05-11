import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.merge-2-platforms-same-person",
  title: "Merge gmail + telegram identities for the same person",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "merge", "entity"],
  description:
    "User confirms the same person reaches them via Gmail (alice@acme.com) and Telegram (@alicechen). The agent must merge into a single entity with both handles, not maintain two parallel rolodex rows.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Merge 2 platforms",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-alice-gmail",
        platform: "gmail",
        handle: "alice@acme.com",
        displayName: "Alice Chen",
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        id: "ent-alice-telegram",
        platform: "telegram",
        handle: "@alicechen",
        displayName: "Alice C.",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "merge-identities",
      room: "main",
      text: "alice@acme.com on email and @alicechen on Telegram are the same person — Alice Chen. Merge them.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "2-platform identity merge",
        includesAny: ["merge", "Alice", "gmail", "telegram"],
      }),
      responseIncludesAny: ["Alice", "merged", "gmail", "telegram"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm the merge resulted in one entity carrying both handles (gmail + telegram). Reply that says 'sure' without naming the unified entity fails.",
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
      name: "identity-merge-2platforms-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "merge gmail+telegram identities",
        includesAny: ["merge", "Alice", "gmail", "telegram"],
      }),
    },
    {
      type: "custom",
      name: "identity-merge-2platforms-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "merged entity persisted",
        contentIncludesAny: ["Alice", "gmail", "telegram", "merged"],
      }),
    },
    judgeRubric({
      name: "identity-merge-2platforms-rubric",
      threshold: 0.7,
      description:
        "Both handles consolidated under one entity (Alice Chen) and stored.",
    }),
  ],
});
