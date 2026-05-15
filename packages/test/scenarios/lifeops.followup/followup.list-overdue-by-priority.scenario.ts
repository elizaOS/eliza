import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "followup.list-overdue-by-priority",
  title: "List overdue follow-ups ordered by VIP priority, not age alone",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "priority", "list"],
  description:
    "Three follow-ups are overdue: a low-priority newsletter draft (oldest), a VIP customer (medium age), and a board member (youngest). The list must lead with VIP/board, not the oldest.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "List overdue by priority",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "overdue-followup",
        name: "Newsletter draft to subscribers",
        priority: "low",
        overdueAt: new Date(now - 10 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "overdue-followup",
        name: "Reply to Acme VIP customer",
        priority: "vip",
        overdueAt: new Date(now - 5 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "overdue-followup",
        name: "Board member intro response",
        priority: "board",
        overdueAt: new Date(now - 2 * DAY_MS).toISOString(),
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-overdue",
      room: "main",
      text: "What's overdue? Order it the way I should actually work it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["LIFE", "INBOX", "RELATIONSHIP"],
        description: "priority-ordered overdue list",
        includesAny: ["VIP", "board", "Acme", "overdue"],
      }),
      responseIncludesAny: ["VIP", "board", "Acme", "newsletter"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must order: board member first, then VIP, then newsletter — not pure age-order (which would put newsletter first). The order must reflect priority weighting, not just timestamps.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["LIFE", "INBOX", "RELATIONSHIP"],
    },
    {
      type: "custom",
      name: "followup-priority-list-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["LIFE", "INBOX", "RELATIONSHIP"],
        description: "priority-ordered overdue list",
      }),
    },
    judgeRubric({
      name: "followup-priority-list-rubric",
      threshold: 0.7,
      description:
        "Overdue list ordered by priority (board > VIP > newsletter), not by age alone.",
    }),
  ],
});
