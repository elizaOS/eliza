import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Deterministic ladder control for the Mac + phone reminder case, driving the
 * REAL `/api/lifeops/reminders/process` endpoint with an injected `now`. The
 * seed anchors the plan at the due instant (`visibilityLeadMinutes: 0`), so
 * the three rungs come due one per process pass (+0m / +30m / +60m) and each
 * pass must deliver exactly its own rung — device-bus fan-out is covered by
 * the real intent-sync and device-bus tests.
 *
 * Assertions parse the attempt rows and scope them to this scenario's unique
 * title: the pr-deterministic lane shares one runtime across the corpus, so
 * body-wide substring checks would read other scenarios' reminder traffic.
 */

const TITLE = "Take meds ladder relay";

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
      return `expected exactly plan rung ${expectedRung} delivered for "${TITLE}" on this pass, saw rungs [${rungs.join(", ")}]`;
    }
    return undefined;
  };
}

function assertFullLadderInspection(
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
    return `expected no blocked_acknowledged attempts before acknowledgement, saw ${JSON.stringify(blocked)}`;
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
  id: "reminder.cross-platform.fires-on-mac-and-phone",
  title: "Reminder ladder fires across all three rungs before acknowledgement",
  domain: "reminders",
  tags: [
    "pr",
    "deterministic",
    "reminders",
    "lifeops",
    "cross-platform",
    "ladder",
  ],
  description:
    "Deterministic ladder control for the Mac + phone reminder case. The scenario proves three reminder rungs fire one per process pass before any acknowledgement; device-bus fan-out is covered by the real intent-sync and device-bus tests.",
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
      name: "seed meeting ladder reminder",
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
      name: "process first rung",
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
      name: "process second rung",
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
      name: "process third rung",
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
      name: "inspect three rung reminder ladder",
      method: "GET",
      path: `/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:${TITLE}}}`,
      expectedStatus: 200,
      assertResponse: assertFullLadderInspection,
    },
  ],
});
