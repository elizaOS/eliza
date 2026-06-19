import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.board-pack-prep",
  title: "Board pack prep gathers docs, metrics, risks, and approvals",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "board-pack", "documents"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Board pack prep",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "board-pack-prep",
      room: "main",
      text: "Prep the board pack brief for Friday: gather docs, open approvals, missing metrics, calendar deadlines, and unresolved risks.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "OWNER_DOCUMENTS",
          "RESOLVE_REQUEST",
          "CALENDAR",
          "BRIEF",
          "LIFE",
        ],
        description: "board pack prep",
        includesAny: ["board", "docs", "approval", "metrics", "risk"],
      }),
      responseIncludesAny: [/board|pack/i, /doc|approval|metric|risk/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should identify board-pack gaps, document needs, approvals, deadlines, and risks without producing a generic meeting note.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "OWNER_DOCUMENTS",
        "RESOLVE_REQUEST",
        "CALENDAR",
        "BRIEF",
        "LIFE",
      ],
    },
    {
      type: "custom",
      name: "board-pack-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "OWNER_DOCUMENTS",
          "RESOLVE_REQUEST",
          "CALENDAR",
          "BRIEF",
          "LIFE",
        ],
        description: "board pack prep",
        includesAny: ["board", "docs", "approval", "metrics", "risk"],
      }),
    },
    judgeRubric({
      name: "executive-board-pack-rubric",
      threshold: 0.7,
      description:
        "Agent prepares a board-pack checklist with docs, approvals, metrics, deadlines, and risks.",
    }),
  ],
});
