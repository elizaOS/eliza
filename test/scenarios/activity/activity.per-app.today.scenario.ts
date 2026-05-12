import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";
import { seedScreenTimeSessions } from "../_helpers/lifeops-seeds.ts";

export default scenario({
  id: "activity.per-app.today",
  title: "Per-app usage report for today",
  domain: "activity",
  tags: ["activity", "smoke", "happy-path"],
  description:
    "User asks which apps they used most today. Seeded app sessions must flow through the screen-time / activity surface.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-app-screen-time",
      apply: seedScreenTimeSessions({
        sessions: [
          {
            source: "app",
            identifier: "com.microsoft.VSCode",
            displayName: "VS Code",
            offsetMinutes: 25,
            durationMinutes: 95,
          },
          {
            source: "app",
            identifier: "com.apple.Safari",
            displayName: "Safari",
            offsetMinutes: 135,
            durationMinutes: 48,
          },
        ],
      }),
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Activity: per-app today",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "per-app-today",
      room: "main",
      text: "Which apps did I use most today?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME", "SCREEN_TIME"],
        description: "per-app usage lookup",
      }),
      responseIncludesAny: [/vs code|safari/i, /today/i, /minute|hour|time/i],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["SCREEN_TIME", "SCREEN_TIME", "SCREEN_TIME"],
    },
    {
      type: "custom",
      name: "per-app-today-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SCREEN_TIME", "SCREEN_TIME", "SCREEN_TIME"],
        description: "per-app usage lookup",
      }),
    },
    {
      type: "custom",
      name: "per-app-today-results",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((action) =>
          ["SCREEN_TIME", "SCREEN_TIME", "SCREEN_TIME"].includes(
            action.actionName,
          ),
        );
        if (!hit) {
          return "expected a screen-time or activity action result";
        }
        const payload = JSON.stringify(hit.result?.data ?? {}).toLowerCase();
        if (!payload.includes("vs code") || !payload.includes("safari")) {
          return "expected seeded Safari and VS Code app usage in result payload";
        }
        if (!/totalms|totalseconds|summary|apps|daily/.test(payload)) {
          return "expected quantitative usage data in result payload";
        }
        return undefined;
      },
    },
  ],
});
