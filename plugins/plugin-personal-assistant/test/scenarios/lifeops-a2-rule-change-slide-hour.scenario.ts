/**
 * A2 adhd-follow-through (live-only scheduler). Casey says meds kicked in late
 * and everything slides an hour. The scheduler proof is structural: the row is
 * snoozed to the new instant, silent at the old instant, and delivered once at
 * the new instant.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  futureDateAtUtc,
  makeA2SchedulerProbe,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/a2-scheduler-probe";

const SCENARIO_ID = "adhd-followthrough-rule-change-slides-reminders";
const CHANNEL_KIND = "scenario_a2_rule_change_slide_delivery";

const ORIGINAL_AT = futureDateAtUtc(10, 0, 10);
const SLID_AT = futureDateAtUtc(11, 0, 10);
const OLD_TICK = futureDateAtUtc(10, 5, 10);
const NEW_TICK = futureDateAtUtc(11, 5, 10);

const probe = makeA2SchedulerProbe({
  scenarioId: SCENARIO_ID,
  channelKind: CHANNEL_KIND,
});

export default scenario({
  id: "adhd-followthrough-rule-change-slides-reminders",
  lane: "live-only",
  title: "ADHD follow-through: rule change slides the reminder by one hour",
  domain: "lifeops",
  tags: ["lifeops", "adhd", "personas", "scheduled-tasks", "12283"],
  status: "active",
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
      title: "A2 Rule Change",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the original late-meds follow-through reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions:
          "gently remind Casey to restart the grant draft after meds settle",
        trigger: { kind: "once", atIso: ORIGINAL_AT.toISOString() },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-grant-draft`,
        metadata: { scenario: SCENARIO_ID, premise: "meds slide one hour" },
      },
      expectedStatus: 201,
      captures: { ruleChangeTaskId: "task.taskId" },
      assertResponse: probe.captureTaskId("ruleChange"),
    },
    {
      kind: "api",
      name: "slide the task one hour later",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:ruleChangeTaskId}}/snooze",
      body: { untilIso: SLID_AT.toISOString() },
      expectedStatus: 200,
      assertResponse: probe.assertTaskStatus("scheduled", {
        lastDecisionIncludes: "snoozed until",
      }),
    },
    {
      kind: "tick",
      name: "old time passes silently",
      worker: "lifeops_scheduler",
      options: {
        now: OLD_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertNoFire("ruleChange"),
    },
    {
      kind: "tick",
      name: "slid time fires once",
      worker: "lifeops_scheduler",
      options: {
        now: NEW_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertFiredOnce("ruleChange", "scheduled_override"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "one delivery at the slid time",
      predicate: probe.assertDeliveryCount(1),
    },
    {
      type: "custom",
      name: "delivery preserves the late-meds context",
      predicate: probe.assertDeliveryIncludes(["meds settle", "grant draft"]),
    },
  ],
});
