/**
 * A2 adhd-follow-through (pr-deterministic). A repeated miss should not become
 * streak-shame. When Casey skips the fired task, the real pipeline creates one
 * smaller next step or pause offer.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  futureDateAtUtc,
  makeA2SchedulerProbe,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/a2-scheduler-probe";

const SCENARIO_ID = "adhd-followthrough-repeated-miss-shrinks-next";
const CHANNEL_KIND = "scenario_a2_repeated_miss_delivery";

const DUE_AT = futureDateAtUtc(9, 0, 7);
const FIRE_TICK = futureDateAtUtc(9, 5, 7);

const probe = makeA2SchedulerProbe({
  scenarioId: SCENARIO_ID,
  channelKind: CHANNEL_KIND,
});

export default scenario({
  id: "adhd-followthrough-repeated-miss-shrinks-next",
  lane: "pr-deterministic",
  title: "ADHD follow-through: repeated miss shrinks the next ask",
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
      title: "A2 Repeated Miss",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the follow-through check Casey has missed before",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "checkin",
        promptInstructions:
          "ask Casey whether the quarterly slides got a ten-minute pass",
        trigger: { kind: "once", atIso: DUE_AT.toISOString() },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${CHANNEL_KIND}:owner`,
        },
        pipeline: {
          onSkip: [
            {
              kind: "followup",
              promptInstructions:
                "Offer Casey one smaller version of the slides task or a pause; do not mention streaks, failure, discipline, or motivation.",
              trigger: { kind: "manual" },
              priority: "low",
              respectsGlobalPause: false,
              source: "user_chat",
              createdBy: SCENARIO_ID,
              ownerVisible: true,
              metadata: {
                scenario: SCENARIO_ID,
                premise: "repeated miss shrink offer",
              },
            },
          ],
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-slides-check`,
        metadata: { scenario: SCENARIO_ID, missCount: 3 },
      },
      expectedStatus: 201,
      captures: { repeatedMissTaskId: "task.taskId" },
      assertResponse: probe.captureTaskId("repeatedMiss"),
    },
    {
      kind: "tick",
      name: "the original check fires once",
      worker: "lifeops_scheduler",
      options: {
        now: FIRE_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertFiredOnce("repeatedMiss"),
    },
    {
      kind: "api",
      name: "Casey skips it after another miss",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:repeatedMissTaskId}}/skip",
      body: { reason: "third miss; shrink or pause instead" },
      expectedStatus: 200,
      assertResponse: probe.assertTaskStatus("skipped", {
        lastDecisionIncludes: "third miss",
      }),
    },
    {
      kind: "api",
      name: "list tasks and prove a smaller follow-up child exists",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: probe.assertPipelineChild("repeatedMiss", [
        "smaller version",
        "pause",
        "do not mention streaks",
      ]),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "only the original check delivered; the shrink offer is stored as a child",
      predicate: probe.assertDeliveryCount(1),
    },
  ],
});
