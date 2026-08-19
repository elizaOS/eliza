/** Proves duplicate reminder processor ticks cannot create a second delivery or receipt. */
import { scenario } from "@elizaos/scenario-runner/schema";

const TITLE = "Submit timesheet idempotency contract";

function attempts(body: unknown): Array<Record<string, unknown>> | null {
  if (!body || typeof body !== "object") return null;
  const rows = (body as { attempts?: unknown }).attempts;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object",
      )
    : null;
}

function assertFirstDelivery(
  _status: number,
  body: unknown,
): string | undefined {
  const rows = attempts(body);
  if (!rows) return `expected attempts array, saw ${JSON.stringify(body)}`;
  const matching = rows.filter((row) => {
    const metadata = row.deliveryMetadata;
    return (
      metadata &&
      typeof metadata === "object" &&
      (metadata as { title?: unknown }).title === TITLE
    );
  });
  if (matching.length !== 1)
    return `expected exactly one first delivery, saw ${matching.length}`;
  if (
    matching[0]?.outcome !== "delivered" &&
    matching[0]?.outcome !== "delivered_read"
  ) {
    return `expected delivered outcome, saw ${String(matching[0]?.outcome)}`;
  }
}

function assertNoAttempt(_status: number, body: unknown): string | undefined {
  const rows = attempts(body);
  if (!rows) return `expected attempts array, saw ${JSON.stringify(body)}`;
  if (rows.length !== 0)
    return `expected replay to produce zero delivery attempts, saw ${JSON.stringify(rows)}`;
}

/**
 * Outcome scenario: a once reminder fires exactly once. Re-running the
 * dispatch processor at the same instant after a successful delivery must not
 * re-deliver — the second pass produces no attempts. This pins the
 * idempotent-retry / no-double-send guarantee (issue #9970 edge-case list):
 * a retry, restart, or duplicate tick can't double-notify the owner.
 */
export default scenario({
  lane: "pr-deterministic",
  id: "reminder-idempotent-retry-outcome",
  title: "Re-processing a delivered reminder does not double-send",
  domain: "reminders",
  evidenceScope: "domain-contract",
  tags: ["pr", "deterministic", "lifeops", "reminders", "idempotency"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Reminder Idempotent Retry",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed due reminder",
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
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 0, label: "In-app reminder" },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process and dispatch reminder",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+10m}}", limit: 10 },
      expectedStatus: 200,
      captures: { occurrenceId: "attempts.0.ownerId" },
      assertResponse: assertFirstDelivery,
    },
    {
      kind: "api",
      name: "re-process at the same instant — no double-send",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+10m}}", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertNoAttempt,
    },
    {
      kind: "api",
      name: "inspect one durable delivery attempt",
      method: "GET",
      path: "/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{capture:occurrenceId}}",
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const rows = attempts(body);
        if (!rows)
          return `expected inspection attempts array, saw ${JSON.stringify(body)}`;
        const delivered = rows.filter(
          (row) =>
            row.outcome === "delivered" || row.outcome === "delivered_read",
        );
        if (delivered.length !== 1 || rows.length !== 1) {
          return `expected exactly one persisted delivery attempt, saw ${JSON.stringify(rows)}`;
        }
      },
    },
  ],
});
