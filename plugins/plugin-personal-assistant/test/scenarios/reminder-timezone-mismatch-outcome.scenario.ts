/** Proves reminder windows resolve in their stored IANA timezone instead of the host timezone. */
import { scenario } from "@elizaos/scenario-runner/schema";

const TITLE = "Tokyo morning travel check-in";

function assertSingleDelivery(
  _status: number,
  body: unknown,
): string | undefined {
  const attempts =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { attempts?: unknown }).attempts)
      ? (body as { attempts: unknown[] }).attempts
      : null;
  if (!attempts) return `expected attempts array, saw ${JSON.stringify(body)}`;
  const matching = attempts.filter((attempt) => {
    if (!attempt || typeof attempt !== "object") return false;
    return (
      (attempt as { deliveryMetadata?: { title?: unknown } }).deliveryMetadata
        ?.title === TITLE
    );
  });
  if (matching.length !== 1)
    return `expected exactly one ${TITLE} attempt, saw ${matching.length}`;
  const row = matching[0] as {
    outcome?: unknown;
    channel?: unknown;
    scheduledFor?: unknown;
  };
  if (row.outcome !== "delivered" && row.outcome !== "delivered_read") {
    return `expected delivered outcome, saw ${String(row.outcome)}`;
  }
  if (row.channel !== "in_app") {
    return `expected in_app channel, saw ${String(row.channel)}`;
  }
  if (row.scheduledFor !== "2027-01-14T20:00:00.000Z") {
    return `expected Tokyo 05:00 window start at 2027-01-14T20:00:00.000Z, saw ${String(row.scheduledFor)}`;
  }
}

/**
 * Outcome scenario: a reminder window is evaluated in the definition's own
 * timezone, not the host/UTC clock. A `daily` morning reminder (local
 * 05:00–12:00) in Asia/Tokyo (UTC+9) is processed at `02:00Z`, which is Tokyo
 * local 11:00 (inside morning) but UTC 02:00 (inside the night window). Delivery
 * proves the window honors the reminder's timezone rather than the processing
 * clock — the timezone-mismatch edge case (issue #9970).
 */
export default scenario({
  lane: "pr-deterministic",
  id: "reminder-timezone-mismatch-outcome",
  title: "A reminder window honors its own timezone, not the host clock",
  domain: "reminders",
  evidenceScope: "domain-contract",
  tags: ["pr", "deterministic", "lifeops", "reminders", "timezone"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Timezone Mismatch",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed a daily morning reminder in Asia/Tokyo",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: TITLE,
        timezone: "Asia/Tokyo",
        priority: 1,
        cadence: {
          kind: "daily",
          windows: ["morning"],
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
      name: "process at 02:00Z — Tokyo morning, but night in UTC",
      method: "POST",
      // 02:00Z = 11:00 Tokyo (UTC+9, inside morning); under a naive UTC clock
      // 02:00 falls in the night window, so delivery proves the window uses the
      // reminder's timezone.
      path: "/api/lifeops/reminders/process",
      body: { now: "2027-01-15T02:00:00.000Z", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertSingleDelivery,
    },
  ],
});
