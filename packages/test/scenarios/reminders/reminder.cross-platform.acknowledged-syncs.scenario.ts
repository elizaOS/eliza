import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Deterministic acknowledgement control for the cross-device ladder case,
 * driving the REAL `/api/lifeops/reminders/process` and
 * `/api/lifeops/reminders/acknowledge` endpoints with an injected `now`. The
 * first rung fires, the owner acknowledges it, and the later rungs (and any
 * escalation) must never dispatch; device-bus sync itself is covered by the
 * real intent-sync ladder tests.
 *
 * Assertions parse the attempt rows and scope them to this scenario's unique
 * title: the pr-deterministic lane shares one runtime across the corpus, so
 * body-wide checks like `"attempts":[]` would read other scenarios' traffic.
 */

const TITLE = "Take meds ack sync";

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

function assertNothingDispatched(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts = attemptsForTitle(body);
  if (typeof attempts === "string") return attempts;
  // Later rungs are visited but must be recorded as blocked_acknowledged —
  // never delivered. An empty pass (rung not yet due) is also acceptable.
  const notBlocked = attempts.filter(
    (attempt) => attempt.outcome !== "blocked_acknowledged",
  );
  if (notBlocked.length > 0) {
    return `acknowledged reminder must suppress every later dispatch for "${TITLE}", saw ${JSON.stringify(notBlocked)}`;
  }
  return undefined;
}

function assertAcknowledgedInspection(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts = attemptsForTitle(body);
  if (typeof attempts === "string") return attempts;
  const rungs = deliveredPlanRungs(attempts);
  if (JSON.stringify(rungs) !== JSON.stringify([0])) {
    return `expected only plan rung 0 delivered for "${TITLE}", saw [${rungs.join(", ")}]`;
  }
  const laterDelivered = attempts.filter(
    (attempt) => attempt.stepIndex > 0 && isDeliveredOutcome(attempt.outcome),
  );
  if (laterDelivered.length > 0) {
    return `expected no deliveries past the acknowledged rung, saw ${JSON.stringify(laterDelivered)}`;
  }
  const blocked = attempts.filter(
    (attempt) => attempt.outcome === "blocked_acknowledged",
  );
  if (blocked.length === 0) {
    return `expected the suppressed rungs to be recorded as blocked_acknowledged, saw ${JSON.stringify(attempts)}`;
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
  id: "reminder.cross-platform.acknowledged-syncs",
  title: "Acknowledging one rung suppresses the remaining ladder",
  domain: "reminders",
  tags: [
    "pr",
    "deterministic",
    "reminders",
    "lifeops",
    "cross-platform",
    "acknowledgement",
  ],
  description:
    "Deterministic acknowledgement control for the cross-device ladder case. The scenario proves the first rung fires, the owner acknowledges it, and later rungs no longer dispatch; device-bus sync itself is covered by the real intent-sync ladder tests.",
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
      name: "seed acknowledged ladder reminder",
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
              label: "First rung",
            },
            {
              channel: "in_app",
              offsetMinutes: 30,
              label: "Second rung",
            },
            {
              channel: "in_app",
              offsetMinutes: 60,
              label: "Third rung",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process first rung before acknowledgement",
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
      name: "acknowledge first rung",
      method: "POST",
      path: "/api/lifeops/reminders/acknowledge",
      body: {
        ownerType: "occurrence",
        ownerId: `{{occurrenceId:${TITLE}}}`,
        acknowledgedAt: "{{now+11m}}",
        note: "saw it on my Mac",
      },
      expectedStatus: 200,
      assertResponse: (_status: number, body: unknown) =>
        JSON.stringify(body ?? "").includes("ok")
          ? undefined
          : `expected acknowledge ok response, saw ${JSON.stringify(body)}`,
    },
    {
      kind: "api",
      name: "process second rung after acknowledgement",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertNothingDispatched,
    },
    {
      kind: "api",
      name: "process third rung after acknowledgement",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+70m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertNothingDispatched,
    },
    {
      kind: "api",
      name: "inspect acknowledged reminder ladder",
      method: "GET",
      path: `/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:${TITLE}}}`,
      expectedStatus: 200,
      assertResponse: assertAcknowledgedInspection,
    },
  ],
});
