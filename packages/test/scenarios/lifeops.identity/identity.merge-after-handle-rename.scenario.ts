import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "identity.merge-after-handle-rename",
  title: "User confirms a Telegram rename and the agent commits the merge",
  domain: "lifeops.identity",
  tags: ["lifeops", "identity", "rename", "merge", "confirmed"],
  description:
    "Second-step of the rename flow: after surfacing the suspected rename, the user explicitly confirms. The agent must merge the two entity rows into one and store the rename event as audit history.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Merge after rename",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        platform: "telegram",
        oldHandle: "@oldhandle",
        newHandle: "@newhandle",
        displayName: "Casey Liu",
        renameConfirmed: false,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "confirm-rename-merge",
      room: "main",
      text: "Yes, that's a rename — @oldhandle is now @newhandle for Casey. Merge them and record the rename event.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "confirmed rename → merge + history",
        includesAny: ["merge", "Casey", "@oldhandle", "@newhandle", "rename"],
      }),
      responseIncludesAny: ["merged", "Casey", "rename", "@newhandle"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm Casey's two telegram rows merged AND that the rename event is preserved as history. Dropping the old handle without recording the rename fails.",
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
      name: "identity-rename-merge-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "confirmed rename merge",
      }),
    },
    {
      type: "custom",
      name: "identity-rename-merge-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "merge + rename history persisted",
        contentIncludesAny: ["Casey", "rename", "@newhandle", "merged"],
      }),
    },
    judgeRubric({
      name: "identity-rename-merge-rubric",
      threshold: 0.7,
      description:
        "Rename merged into one entity with audit history preserved.",
    }),
  ],
});
