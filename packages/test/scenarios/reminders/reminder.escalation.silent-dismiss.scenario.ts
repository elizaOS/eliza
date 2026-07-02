import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Deterministic silent-dismiss control driving the REAL
 * `/api/lifeops/reminders/process` endpoint with an injected `now`: the owner
 * never acknowledges, so every plan rung must deliver on its own pass and the
 * critical reminder must keep escalating.
 *
 * Assertions parse the attempt rows and scope them to this scenario's unique
 * title: the pr-deterministic lane shares one runtime across the corpus, so
 * body-wide substring checks would read other scenarios' reminder traffic.
 */

const TITLE = "Call dentist silent dismiss";

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

function assertRungDelivered(
  expectedRung: number,
): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const attempts = attemptsForTitle(body);
    if (typeof attempts === "string") return attempts;
    const rungs = deliveredPlanRungs(attempts);
    if (JSON.stringify(rungs) !== JSON.stringify([expectedRung])) {
      return `expected exactly plan rung ${expectedRung} delivered for "${TITLE}" on this pass, saw [${rungs.join(", ")}]`;
    }
    return undefined;
  };
}

function assertSilentDismissInspection(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts = attemptsForTitle(body);
  if (typeof attempts === "string") return attempts;
  const rungs = deliveredPlanRungs(attempts);
  if (JSON.stringify(rungs) !== JSON.stringify([0, 1, 2])) {
    return `expected all three plan rungs delivered for "${TITLE}", saw [${rungs.join(", ")}]`;
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
  id: "reminder.escalation.silent-dismiss",
  title: "User silently dismisses reminders and escalation continues",
  domain: "reminders",
  tags: [
    "pr",
    "deterministic",
    "lifeops",
    "reminders",
    "escalation",
    "permission-denied",
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
      name: "seed silent task",
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
            {
              channel: "in_app",
              offsetMinutes: 60,
              label: "Urgent reminder",
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
      assertResponse: assertRungDelivered(0),
    },
    {
      kind: "api",
      name: "process second reminder ignored",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertRungDelivered(1),
    },
    {
      kind: "api",
      name: "process third reminder still escalating",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+70m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertRungDelivered(2),
    },
    {
      kind: "api",
      name: "inspect reminder lifecycle after silent dismiss",
      method: "GET",
      path: `/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:${TITLE}}}`,
      expectedStatus: 200,
      assertResponse: assertSilentDismissInspection,
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
