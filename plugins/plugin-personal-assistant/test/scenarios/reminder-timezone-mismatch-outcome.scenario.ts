// Defines the reminder timezone mismatch outcome LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

function assertApiBody(options: {
  includesAll?: ReadonlyArray<string>;
}): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const serialized =
      typeof body === "string" ? body : JSON.stringify(body ?? "");
    for (const needle of options.includesAll ?? []) {
      if (!serialized.includes(needle)) {
        return `expected body to include "${needle}"`;
      }
    }
  };
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
  lane: "live-only",
  id: "reminder-timezone-mismatch-outcome",
  title: "A reminder window honors its own timezone, not the host clock",
  domain: "reminders",
  tags: ["lifeops", "reminders"],
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
        title: "Tokyo morning check-in",
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
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
  ],
});
