/**
 * Keyless per-plugin e2e for `@elizaos/plugin-finances` (issue #8801).
 *
 * `plugin-finances` registers no Action of its own — it owns the payments
 * back-end (`FinancesService` + the `app_finances` drizzle schema) and the
 * `runPaymentsHandler` dispatch. The registered agent surface is the
 * `OWNER_FINANCES` umbrella in `@elizaos/plugin-personal-assistant`, whose
 * handler (`runMoneyHandler`) delegates straight into `runPaymentsHandler`
 * here. So the scenario loads both plugins and drives the read-only
 * `dashboard` subaction end to end through the deterministic LLM proxy with
 * zero credentials: routing fixtures select `OWNER_FINANCES`, the planner
 * calls it with `action: "dashboard"`, and the finances back-end reads the
 * (empty) migrated `app_finances` tables and returns the composite dashboard
 * payload. No `useModel` call is made inside the handler, so two route
 * fixtures cover the whole turn.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "../_helpers/effect-assertions.ts";

const FINANCES_INPUT = "Pull up my finances dashboard for the last 30 days.";
const OWNER_FINANCES = "OWNER_FINANCES";

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function financesRouteFixtures(): Array<Record<string, unknown>> {
  const inputMatches = (value: string) => value.includes("finances dashboard");
  return [
    {
      name: "route-owner-finances-stage1",
      match: {
        modelType: ModelType.RESPONSE_HANDLER,
        input: inputMatches,
        toolName: "HANDLE_RESPONSE",
      },
      response: {
        contexts: ["finance"],
        intents: ["finances"],
        replyText: "",
        threadOps: [],
        candidateActionNames: [OWNER_FINANCES],
      },
      times: 1,
    },
    {
      name: "route-owner-finances-planner",
      match: {
        modelType: ModelType.ACTION_PLANNER,
        input: inputMatches,
        toolName: OWNER_FINANCES,
      },
      response: {
        text: "",
        thought: "Read the owner's finances dashboard.",
        messageToUser: "",
        completed: true,
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "call-owner-finances",
            name: OWNER_FINANCES,
            type: "function",
            arguments: { action: "dashboard" },
          },
        ],
      },
      times: 1,
    },
    {
      // Post-action FINISH/CONTINUE decision: a RESPONSE_HANDLER call with no
      // HANDLE_RESPONSE tool, made after OWNER_FINANCES returns the dashboard.
      name: "route-owner-finances-decision",
      match: (call: { modelType: string; toolNames?: string[] }) =>
        call.modelType === ModelType.RESPONSE_HANDLER &&
        !(call.toolNames ?? []).includes("HANDLE_RESPONSE"),
      response: {
        success: true,
        decision: "FINISH",
        thought: "The finances dashboard was returned to the owner.",
        messageToUser: "Here is your finances dashboard for the last 30 days.",
      },
      times: 1,
    },
  ];
}

export default scenario({
  lane: "pr-deterministic",
  id: "finances.owner-finances-dashboard",
  title: "Finances: OWNER_FINANCES returns the payments dashboard",
  domain: "finances",
  tags: ["smoke", "finances", "owner-finances", "payments"],
  description:
    "Sends a finances-dashboard request and verifies the OWNER_FINANCES action is selected and the plugin-finances back-end returns the dashboard payload via the deterministic LLM proxy — keyless, no credentials.",

  requires: {
    plugins: ["@elizaos/plugin-finances", "@elizaos/plugin-personal-assistant"],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-strict-finances-route-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        runtime.scenarioLlmFixtures?.register(...financesRouteFixtures());
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Finances: dashboard",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "read-finances-dashboard",
      text: FINANCES_INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (action) => action.actionName === OWNER_FINANCES,
        );
        if (!call) {
          return `Expected ${OWNER_FINANCES} but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${OWNER_FINANCES} did not succeed: ${
            call.error?.message ?? "unknown error"
          }`;
        }
        const data = call.result?.data as
          | { dashboard?: { spending?: { transactionCount?: number } } }
          | undefined;
        if (typeof data?.dashboard?.spending?.transactionCount !== "number") {
          return "expected OWNER_FINANCES to return dashboard.spending.transactionCount";
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: OWNER_FINANCES,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the dashboard contract is the composite
      // payload assembled off the migrated `app_finances` tables —
      // `data.dashboard` with a numeric spending rollup plus the recurring
      // and sources collections. A handler that "succeeds" without actually
      // reading the back-end (missing/partial composite) fails here.
      type: "custom",
      name: "finances-dashboard-composite-read",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, OWNER_FINANCES);
        const dashboard = toRecord(data?.dashboard);
        if (!dashboard) {
          return `no ${OWNER_FINANCES} result data.dashboard; calls: ${describeCalls(ctx)}`;
        }
        const spending = toRecord(dashboard.spending);
        if (
          typeof spending?.transactionCount !== "number" ||
          typeof spending?.windowDays !== "number"
        ) {
          return `expected dashboard.spending {transactionCount, windowDays} numbers from the app_finances read, saw ${JSON.stringify(dashboard.spending).slice(0, 200)}`;
        }
        if (
          !Array.isArray(dashboard.recurring) ||
          !Array.isArray(dashboard.sources)
        ) {
          return `expected dashboard.recurring + dashboard.sources arrays, saw keys ${Object.keys(dashboard).join(",")}`;
        }
      },
    },
  ],
});
