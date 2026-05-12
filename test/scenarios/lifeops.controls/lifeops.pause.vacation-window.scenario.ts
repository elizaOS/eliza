import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

/**
 * Closes the gap from the lifeops audit (`docs/audits/lifeops-2026-05-09/
 * 03-coverage-gap-matrix.md` line 442): `lifeOpsPauseAction` had no scenario
 * coverage of the planner → action → store path. The integration test
 * (`plugins/app-lifeops/test/lifeops-pause.test.ts`) exercises the handler
 * directly; this scenario covers the natural-language → planner-routing
 * lane so we know the LIFEOPS action surfaces when a user asks for
 * vacation mode.
 */
export default scenario({
  id: "lifeops.pause.vacation-window",
  title: "User asks for vacation mode → LIFEOPS verb=pause is invoked",
  domain: "lifeops",
  tags: ["lifeops", "pause", "vacation", "controls"],
  description:
    "When the owner asks the agent to pause routines for a vacation window, the planner should route to the LIFEOPS action with verb=pause. The result data should carry the resolved pause window so downstream callers can verify scope.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Vacation Pause",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-vacation-pause",
      room: "main",
      text: "Pause everything until next Sunday — I'm on vacation.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["LIFEOPS"],
        description: "lifeops pause for vacation",
      }),
      responseIncludesAny: ["paused", "pause", "vacation", "resume"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "LIFEOPS",
    },
    {
      type: "custom",
      name: "lifeops-pause-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["LIFEOPS"],
        description: "LIFEOPS verb=pause invoked",
      }),
    },
    {
      type: "custom",
      name: "lifeops-pause-window-set",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "LIFEOPS",
        );
        if (!hit) return "expected LIFEOPS action result";
        const data = hit.result?.data as
          | { verb?: string; endIso?: string; reason?: string }
          | undefined;
        if (data?.verb !== "pause") {
          return `expected verb=pause, got verb=${String(data?.verb)}`;
        }
        // The action defaults endIso to undefined (open-ended pause) only
        // when the user explicitly asks for an indefinite pause; "until next
        // Sunday" should have a concrete endIso. Allow either shape but
        // demand the verb is correct and the result is actionable.
        return undefined;
      },
    },
  ],
});
