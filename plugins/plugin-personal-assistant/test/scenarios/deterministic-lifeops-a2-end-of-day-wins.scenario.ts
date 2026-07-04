/**
 * A2 adhd-follow-through (pr-deterministic). End-of-day recap should lead with
 * wins, not misses. The scheduler fires the actual recap row and the delivery
 * ledger proves the prompt the dispatcher emitted.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  futureDateAtUtc,
  makeA2SchedulerProbe,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/a2-scheduler-probe";

const SCENARIO_ID = "adhd-followthrough-end-of-day-recap-leads-with-wins";
const CHANNEL_KIND = "scenario_a2_end_of_day_wins_delivery";

const RECAP_AT = futureDateAtUtc(18, 0, 9);
const RECAP_TICK = futureDateAtUtc(18, 5, 9);

const probe = makeA2SchedulerProbe({
  scenarioId: SCENARIO_ID,
  channelKind: CHANNEL_KIND,
});

export default scenario({
  id: "adhd-followthrough-end-of-day-recap-leads-with-wins",
  lane: "pr-deterministic",
  title: "ADHD follow-through: end-of-day recap leads with wins",
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
      title: "A2 Wins Recap",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the end-of-day recap",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "recap",
        promptInstructions:
          "End-of-day recap for Casey: lead with wins completed today before misses, keep it short, and avoid scorekeeping language.",
        trigger: { kind: "once", atIso: RECAP_AT.toISOString() },
        priority: "low",
        output: {
          destination: "channel",
          target: `${CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-wins-recap`,
        metadata: { scenario: SCENARIO_ID, premise: "wins-first recap" },
      },
      expectedStatus: 201,
      captures: { recapTaskId: "task.taskId" },
      assertResponse: probe.captureTaskId("recap"),
    },
    {
      kind: "tick",
      name: "recap fires at end of day",
      worker: "lifeops_scheduler",
      options: {
        now: RECAP_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertFiredOnce("recap"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "recap delivered exactly once",
      predicate: probe.assertDeliveryCount(1),
    },
    {
      type: "custom",
      name: "delivery prompt leads with wins before misses",
      predicate: probe.assertDeliveryIncludes([
        "lead with wins",
        "before misses",
        "avoid scorekeeping",
      ]),
    },
  ],
});
