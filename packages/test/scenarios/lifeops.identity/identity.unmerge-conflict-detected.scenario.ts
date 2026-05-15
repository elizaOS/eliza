import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.unmerge-conflict-detected",
  title:
    "Detect a wrong-merge and unmerge while preserving each side's history",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "unmerge", "conflict"],
  description:
    "Two people were accidentally merged into one entity (same display name 'Alex Lee', different real people). User flags the bad merge. Agent must split, preserve each history, and confirm which messages belong where.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Unmerge conflict",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "merged-entity",
        id: "ent-alex-lee-merged",
        displayName: "Alex Lee",
        handles: [
          {
            platform: "gmail",
            handle: "alex.lee@quanta.com",
            realPerson: "alex-1",
          },
          { platform: "telegram", handle: "@alexlee", realPerson: "alex-2" },
        ],
        mergedAccidentally: true,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-unmerge",
      room: "main",
      text: "The Alex Lee on Telegram is not the same person as Alex Lee at Quanta. They got merged. Split them back into two separate entities.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "unmerge with history preserved per side",
        includesAny: ["unmerge", "split", "Alex Lee", "two"],
      }),
      responseIncludesAny: ["unmerge", "split", "two", "Alex Lee"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm a split into two entities, surface that gmail history goes with Alex@Quanta and telegram history goes with @alexlee, and avoid losing either's interactions. Saying 'okay split' without naming which handle goes where fails.",
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
      name: "identity-unmerge-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "unmerge two entities",
      }),
    },
    {
      type: "custom",
      name: "identity-unmerge-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "split written so the two sides exist independently",
        contentIncludesAny: ["unmerge", "split", "Alex Lee"],
      }),
    },
    judgeRubric({
      name: "identity-unmerge-rubric",
      threshold: 0.7,
      description:
        "Split executed with each side keeping its handle and history.",
    }),
  ],
});
