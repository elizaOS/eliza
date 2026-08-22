/**
 * Keyless per-plugin e2e for `@elizaos/plugin-finances`.
 *
 * `plugin-finances` registers no Action of its own — it owns the payments
 * back-end (`FinancesService` + the `app_finances` drizzle schema) and the
 * `runPaymentsHandler` dispatch. The registered agent surface is the
 * `OWNER_FINANCES` umbrella in `@elizaos/plugin-personal-assistant`, whose
 * handler (`runMoneyHandler`) delegates straight into `runPaymentsHandler`
 * here. So the scenario loads both plugins and drives the read-only
 * `dashboard` subaction end to end with zero credentials: a direct action turn
 * calls `OWNER_FINANCES` with `action: "dashboard"`, and the finances back-end reads the
 * (empty) migrated `app_finances` tables and returns the composite dashboard
 * payload. No `useModel` call is made inside the handler, so two route
 * fixtures cover the whole turn.
 */
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const FINANCES_INPUT = "Pull up my finances dashboard for the last 30 days.";
const OWNER_FINANCES = "OWNER_FINANCES";

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason: "direct production action path has no model boundary",
  },
  id: "finances.owner-finances-dashboard",
  title: "Finances: OWNER_FINANCES returns the payments dashboard",
  domain: "finances",
  tags: ["smoke", "finances", "owner-finances", "payments"],
  description:
    "Calls OWNER_FINANCES directly and verifies the plugin-finances back-end returns the dashboard payload — keyless, no credentials or model calls.",

  requires: {
    plugins: ["@elizaos/plugin-finances", "@elizaos/plugin-personal-assistant"],
  },
  isolation: "per-scenario",

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
      kind: "action",
      name: "read-finances-dashboard",
      actionName: OWNER_FINANCES,
      options: { parameters: { action: "dashboard" } },
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
