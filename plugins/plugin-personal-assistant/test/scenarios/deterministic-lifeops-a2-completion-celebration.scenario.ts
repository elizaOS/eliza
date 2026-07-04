/**
 * A2 adhd-follow-through (pr-deterministic). Completion should produce a
 * proportional win note, not a giant celebration or a new plan. This proves
 * the completion pipeline creates the right child and only after completion.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  futureDateAtUtc,
  makeA2SchedulerProbe,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/a2-scheduler-probe";

const SCENARIO_ID = "adhd-followthrough-completion-celebrates-proportionally";
const CHANNEL_KIND = "scenario_a2_completion_celebration_delivery";

const DUE_AT = futureDateAtUtc(15, 0, 8);
const FIRE_TICK = futureDateAtUtc(15, 5, 8);

const probe = makeA2SchedulerProbe({
  scenarioId: SCENARIO_ID,
  channelKind: CHANNEL_KIND,
});

export default scenario({
  id: "adhd-followthrough-completion-celebrates-proportionally",
  lane: "pr-deterministic",
  title: "ADHD follow-through: completion gets a proportional win note",
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
      title: "A2 Completion",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the receipt upload follow-through task",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "nudge Casey to upload the last receipt photo",
        trigger: { kind: "once", atIso: DUE_AT.toISOString() },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${CHANNEL_KIND}:owner`,
        },
        pipeline: {
          onComplete: [
            {
              kind: "recap",
              promptInstructions:
                "Name the receipt upload as one win in one sentence; keep it proportional, do not over-celebrate, and do not add another plan.",
              trigger: { kind: "manual" },
              priority: "low",
              respectsGlobalPause: false,
              source: "user_chat",
              createdBy: SCENARIO_ID,
              ownerVisible: true,
              metadata: {
                scenario: SCENARIO_ID,
                premise: "proportional completion celebration",
              },
            },
          ],
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-receipt-upload`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      captures: { completionTaskId: "task.taskId" },
      assertResponse: probe.captureTaskId("completion"),
    },
    {
      kind: "tick",
      name: "the receipt task fires",
      worker: "lifeops_scheduler",
      options: {
        now: FIRE_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertFiredOnce("completion"),
    },
    {
      kind: "api",
      name: "complete the receipt task",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:completionTaskId}}/complete",
      body: { reason: "Casey uploaded the receipt photo" },
      expectedStatus: 200,
      assertResponse: probe.assertTaskStatus("completed", {
        lastDecisionIncludes: "uploaded the receipt",
      }),
    },
    {
      kind: "api",
      name: "list tasks and prove proportional completion child exists",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: probe.assertPipelineChild("completion", [
        "one win",
        "one sentence",
        "do not over-celebrate",
      ]),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "only the actionable reminder delivered before completion",
      predicate: probe.assertDeliveryCount(1),
    },
  ],
});
