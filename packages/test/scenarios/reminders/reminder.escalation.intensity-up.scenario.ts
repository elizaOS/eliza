import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Deterministic escalation control driving the REAL
 * `/api/lifeops/reminders/process` endpoint with an injected `now`: an
 * ignored critical reminder must deliver rung 0, then rung 1 PLUS at least
 * one delivered escalation attempt once its unacknowledged review lapses.
 *
 * Assertions parse the attempt rows and scope them to this scenario's unique
 * title: the pr-deterministic lane shares one runtime across the corpus, so
 * body-wide substring checks would read other scenarios' reminder traffic.
 */

const TITLE = "Call dentist intensity probe";

type JsonRecord = Record<string, unknown>;

interface ReminderAttempt {
  stepIndex: number;
  outcome: string;
  lifecycle?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function attemptsForTitle(body: unknown): ReminderAttempt[] | string {
  if (!isRecord(body)) {
    return `expected response object, saw ${JSON.stringify(body)}`;
  }
  const raw = body.attempts;
  if (!Array.isArray(raw)) {
    return `expected attempts array, saw ${JSON.stringify(raw)}`;
  }
  const attempts: ReminderAttempt[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const metadata = isRecord(entry.deliveryMetadata)
      ? entry.deliveryMetadata
      : {};
    if (metadata.title !== TITLE) continue;
    if (typeof entry.stepIndex !== "number") {
      return `attempt for ${TITLE} is missing stepIndex: ${JSON.stringify(entry)}`;
    }
    attempts.push({
      stepIndex: entry.stepIndex,
      outcome: typeof entry.outcome === "string" ? entry.outcome : "",
      ...(typeof metadata.lifecycle === "string"
        ? { lifecycle: metadata.lifecycle }
        : {}),
    });
  }
  return attempts;
}

/**
 * `scanReadReceipts` upgrades a `delivered` attempt to `delivered_read` when
 * the owner was seen active after the send — in the shared pr-deterministic
 * runtime, earlier scenarios' message turns count as owner activity. Both
 * outcomes mean the rung dispatched.
 */
function isDeliveredOutcome(outcome: string): boolean {
  return outcome === "delivered" || outcome === "delivered_read";
}

function deliveredPlanRungs(attempts: ReminderAttempt[]): number[] {
  return attempts
    .filter(
      (attempt) =>
        attempt.lifecycle === "plan" && isDeliveredOutcome(attempt.outcome),
    )
    .map((attempt) => attempt.stepIndex)
    .sort((a, b) => a - b);
}

function assertFirstRungDelivered(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts = attemptsForTitle(body);
  if (typeof attempts === "string") return attempts;
  const rungs = deliveredPlanRungs(attempts);
  if (JSON.stringify(rungs) !== JSON.stringify([0])) {
    return `expected exactly plan rung 0 delivered for "${TITLE}", saw [${rungs.join(", ")}]`;
  }
  return undefined;
}

function assertEscalatedSecondPass(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts = attemptsForTitle(body);
  if (typeof attempts === "string") return attempts;
  const rungs = deliveredPlanRungs(attempts);
  if (JSON.stringify(rungs) !== JSON.stringify([1])) {
    return `expected exactly plan rung 1 delivered for "${TITLE}" on the second pass, saw [${rungs.join(", ")}]`;
  }
  const escalations = attempts.filter(
    (attempt) =>
      attempt.lifecycle === "escalation" && isDeliveredOutcome(attempt.outcome),
  );
  if (escalations.length === 0) {
    return `expected the ignored critical reminder to escalate on the second pass, saw only ${JSON.stringify(attempts)}`;
  }
  return undefined;
}

function assertIgnoredLadderInspection(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts = attemptsForTitle(body);
  if (typeof attempts === "string") return attempts;
  const rungs = deliveredPlanRungs(attempts);
  if (JSON.stringify(rungs) !== JSON.stringify([0, 1])) {
    return `expected both plan rungs delivered for "${TITLE}", saw [${rungs.join(", ")}]`;
  }
  const blocked = attempts.filter(
    (attempt) => attempt.outcome === "blocked_acknowledged",
  );
  if (blocked.length > 0) {
    return `expected no blocked_acknowledged attempts (the reminder was never acknowledged), saw ${JSON.stringify(blocked)}`;
  }
  return undefined;
}

/**
 * The pr-deterministic lane shares one runtime across the corpus, so the
 * per-agent `reminders_process` budget (10/min) is shared too. Reset the
 * limiter so this scenario's own passes cannot be starved by earlier
 * scenarios' API traffic.
 */
async function resetSharedRateLimits(): Promise<string | undefined> {
  const { resetRateLimits } = await import("@elizaos/agent");
  resetRateLimits();
  return undefined;
}

export default scenario({
  lane: "pr-deterministic",
  id: "reminder.escalation.intensity-up",
  title: "Ignored reminder escalates intensity on next check",
  domain: "reminders",
  tags: [
    "pr",
    "deterministic",
    "lifeops",
    "reminders",
    "escalation",
    "retry-after-failure",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "reset shared-runtime API rate limits",
      apply: resetSharedRateLimits,
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed urgent task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: TITLE,
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+10m}}",
          visibilityLeadMinutes: 0,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            {
              channel: "in_app",
              offsetMinutes: 0,
              label: "In-app reminder",
            },
            {
              channel: "in_app",
              offsetMinutes: 30,
              label: "Follow-up reminder",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process first reminder",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+10m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertFirstRungDelivered,
    },
    {
      kind: "api",
      name: "process escalated reminder after ignore",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertEscalatedSecondPass,
    },
    {
      kind: "api",
      name: "inspect ignored reminder ladder",
      method: "GET",
      path: `/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:${TITLE}}}`,
      expectedStatus: 200,
      assertResponse: assertIgnoredLadderInspection,
    },
  ],
  finalChecks: [
    {
      type: "reminderIntensity",
      title: TITLE,
      expected: "escalated",
    },
  ],
});
