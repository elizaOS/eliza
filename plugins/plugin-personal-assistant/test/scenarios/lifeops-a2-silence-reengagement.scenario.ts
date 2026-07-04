/**
 * A2 adhd-follow-through (live-only scheduler). A quiet/no-reply lapse should
 * re-engage gently via the no-reply retry path, not mark Casey as failed. This
 * drives the real completion-timeout pass after a fired check-in.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  futureDateAtUtc,
  makeA2SchedulerProbe,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/a2-scheduler-probe";

const SCENARIO_ID = "adhd-followthrough-silence-reengagement-retries-gently";
const CHANNEL_KIND = "scenario_a2_silence_reengagement_delivery";

const CHECKIN_AT = futureDateAtUtc(16, 0, 11);
const FIRE_TICK = futureDateAtUtc(16, 5, 11);
const TIMEOUT_TICK = futureDateAtUtc(16, 45, 11);

const probe = makeA2SchedulerProbe({
  scenarioId: SCENARIO_ID,
  channelKind: CHANNEL_KIND,
});

export default scenario({
  id: "adhd-followthrough-silence-reengagement-retries-gently",
  lane: "live-only",
  title: "ADHD follow-through: silence re-engages with a gentle retry",
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
      title: "A2 Silence Reengagement",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the quiet-user check-in",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "checkin",
        promptInstructions:
          "ask Casey if she wants one tiny next step or a pause on the taxes pile",
        trigger: { kind: "once", atIso: CHECKIN_AT.toISOString() },
        priority: "medium",
        output: {
          destination: "channel",
          target: `${CHANNEL_KIND}:owner`,
        },
        completionCheck: {
          kind: "user_replied_within",
          params: { lookbackMinutes: 10, requireSinceTaskFired: true },
          followupAfterMinutes: 30,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-taxes-checkin`,
        metadata: {
          scenario: SCENARIO_ID,
          premise: "quiet reengagement without guilt",
        },
      },
      expectedStatus: 201,
      captures: { silenceTaskId: "task.taskId" },
      assertResponse: probe.captureTaskId("silence"),
    },
    {
      kind: "tick",
      name: "the check-in fires",
      worker: "lifeops_scheduler",
      options: {
        now: FIRE_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertFiredOnce("silence"),
    },
    {
      kind: "tick",
      name: "no reply triggers the gentle retry path",
      worker: "lifeops_scheduler",
      options: {
        now: TIMEOUT_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: probe.assertCompletionTimeout(
        "silence",
        "scheduled",
        "no_reply_retry",
      ),
    },
    {
      kind: "api",
      name: "list tasks and prove timeout did not spawn a shame child",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: probe.assertNoPipelineChild("silence"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "only the original check-in delivered before the retry was scheduled",
      predicate: probe.assertDeliveryCount(1),
    },
  ],
});
