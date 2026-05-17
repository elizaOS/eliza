import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "relationships.status-goals.progress",
  title: "Quarterly relationship progress routes into follow-up list review",
  domain: "relationships",
  tags: ["lifeops", "relationships", "follow-up"],
  description:
    "A quarterly relationship-progress question currently routes into the generic follow-up list flow.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: goal progress",
    },
  ],

  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Alice Chen",
        relationshipGoal: "stay in touch quarterly",
        followupThresholdDays: 90,
        lastContactedAt: new Date(now - 100 * DAY_MS).toISOString(),
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "progress-query",
      room: "main",
      text: "Who should I follow up with to stay on track with my quarterly relationship goals?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "quarterly relationship follow-up review",
        includesAny: ["quarter", "follow"],
      }),
      responseIncludesAny: ["follow-up", "due"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "RELATIONSHIP",
      minCount: 1,
    },
    {
      type: "custom",
      name: "relationship-progress-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "quarterly relationship follow-up review",
        includesAny: ["quarter", "follow"],
      }),
    },
    {
      type: "custom",
      name: "relationship-progress-followup-list",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "RELATIONSHIP",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                subaction?: string;
                followUps?: unknown[];
                overdue?: unknown[];
              })
            : null;
        if (!data) {
          return "expected RELATIONSHIP result data";
        }
        if (
          data.subaction !== "follow_up_list" &&
          data.subaction !== "list_overdue_followups"
        ) {
          return `expected follow-up list subaction, got ${data.subaction ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
