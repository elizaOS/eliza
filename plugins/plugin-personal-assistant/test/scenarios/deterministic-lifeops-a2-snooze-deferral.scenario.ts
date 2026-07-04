/**
 * A2 adhd-follow-through (pr-deterministic). Legitimate "can't now, after
 * lunch" deferral must snooze the reminder and resurface it later instead of
 * dropping it or firing at the original time.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  futureDateAtUtc,
  makeA2SchedulerProbe,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/a2-scheduler-probe";

const SCENARIO_ID = "adhd-followthrough-snooze-legitimate-deferral";
const CHANNEL_KIND = "scenario_a2_snooze_deferral_delivery";

const DUE_AT = futureDateAtUtc(12, 0, 6);
const AFTER_LUNCH = futureDateAtUtc(13, 30, 6);
const ORIGINAL_TICK = futureDateAtUtc(12, 5, 6);
const DEFERRAL_TICK = futureDateAtUtc(13, 35, 6);

const probe = makeA2SchedulerProbe({
  scenarioId: SCENARIO_ID,
  channelKind: CHANNEL_KIND,
});

export default scenario({
  id: "adhd-followthrough-snooze-legitimate-deferral",
  lane: "pr-deterministic",
  title: "ADHD follow-through: legitimate deferral snoozes, then resurfaces",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "adhd",
    "personas",
    "scheduled-tasks",
    "12283",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "register delivery channel and reset task captures",
      apply: probe.seedChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "A2 Snooze Deferral",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the lunch-blocked follow-through reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions:
          "send Casey one gentle nudge to submit the receipt photo",
        trigger: { kind: "once", atIso: DUE_AT.toISOString() },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-receipt-photo`,
        metadata: { scenario: SCENARIO_ID, premise: "after lunch deferral" },
      },
      expectedStatus: 201,
      captures: { deferredTaskId: "task.taskId" },
      assertResponse: probe.captureTaskId("deferred"),
    },
    {
      kind: "api",
      name: "snooze until after lunch rather than dropping it",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:deferredTaskId}}/snooze",
      body: { untilIso: AFTER_LUNCH.toISOString() },
      expectedStatus: 200,
      assertResponse: probe.assertTaskStatus("scheduled", {
        lastDecisionIncludes: "snoozed until",
      }),
    },
    {
      kind: "tick",
      name: "original due time passes without firing",
      worker: "lifeops_scheduler",
      options: {
        now: ORIGINAL_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertNoFire("deferred"),
    },
    {
      kind: "tick",
      name: "after-lunch tick resurfaces the same task once",
      worker: "lifeops_scheduler",
      options: {
        now: DEFERRAL_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertFiredOnce("deferred", "scheduled_override"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery after the legitimate deferral",
      predicate: probe.assertDeliveryCount(1),
    },
  ],
});
