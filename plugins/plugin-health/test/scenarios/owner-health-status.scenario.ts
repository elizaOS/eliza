/**
 * Keyless per-plugin e2e for `@elizaos/plugin-health`.
 *
 * `plugin-health` ships no registered agent action of its own — its action
 * surface is a set of host-adapted factories (`createOwnerHealthAction` /
 * `createHealthActionRunner`) that `@elizaos/plugin-personal-assistant` wires
 * into the `OWNER_HEALTH` umbrella action (today | trend | by_metric | status).
 * Exercising plugin-health therefore means calling `OWNER_HEALTH` directly
 * with zero credentials and asserting the health
 * factory's handler runs and succeeds.
 *
 * The `status` op is the keyless-clean path: it reads the local health-backend
 * detection (`detectHealthBackend` -> `none` with no connector configured) and
 * reports "no bridge available" without any network call, OAuth token, device
 * bridge, or DB row. The host re-voices the canonical fallback through one
 * `TEXT_SMALL` grounded-reply call, which the proxy answers deterministically.
 *
 * Loading `@elizaos/plugin-personal-assistant` (the OWNER_HEALTH host) +
 * `@elizaos/plugin-scheduling` (its declared runner dependency) mirrors the
 * existing `deterministic-lifeops-scheduled-tasks` keyless scenario.
 */
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const OWNER_HEALTH = "OWNER_HEALTH";
const STATUS_INPUT = "Run OWNER_HEALTH to check my health backend status.";
const GROUNDED_REPLY =
  "You have no HealthKit or Google Fit bridge connected yet. Connect Strava, Fitbit, Withings, or Oura in LifeOps settings and I can start pulling your stats.";

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "owner-health-grounded-reply",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "Scenario: health_status" },
        },
        response: { text: GROUNDED_REPLY },
      },
    ],
  },
  id: "health.owner-health-status",
  title: "Health: OWNER_HEALTH reports backend status keyless",
  domain: "health",
  tags: ["smoke", "health", "owner-health"],
  description:
    "Calls OWNER_HEALTH (status) directly and verifies the plugin-health action factory runs and succeeds with no connector configured — keyless, no credentials.",

  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
      "@elizaos/plugin-health",
    ],
  },
  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Health: status",
    },
  ],

  turns: [
    {
      kind: "action",
      name: "health-status",
      actionName: OWNER_HEALTH,
      options: { parameters: { action: "status" } },
      text: STATUS_INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (action) => action.actionName === OWNER_HEALTH,
        );
        if (!call) {
          return `Expected ${OWNER_HEALTH} but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${OWNER_HEALTH} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: OWNER_HEALTH,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the status op really ran the health-backend
      // detection — with no connector configured it must surface the real
      // "no backend" connector status in the result payload, not just
      // handler success.
      type: "custom",
      name: "health-backend-detection-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, OWNER_HEALTH);
        if (!data) {
          return `no successful ${OWNER_HEALTH} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.subaction !== "status") {
          return `expected result.data.subaction "status", saw ${String(data.subaction ?? "(missing)")}`;
        }
        const status = toRecord(data.status);
        if (!status) {
          return `expected the detected connector status in result.data.status; saw ${JSON.stringify(data).slice(0, 300)}`;
        }
        if (status.available !== false) {
          return `keyless runtime has no health connector, so status.available must be false; saw ${JSON.stringify(status).slice(0, 300)}`;
        }
      },
    },
  ],
});
