// Defines the reminder daily recurrence outcome LifeOps scenario-runner spec.
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
 * Outcome scenario: a daily-recurring reminder fires on consecutive days. A
 * `daily` cadence in the morning window (05:00–12:00 UTC) delivers when
 * processed inside the window on day 1 and again on day 2 — recurrence
 * regenerates the occurrence rather than firing once. Pins the multi-day
 * recurrence edge case (issue #9970). Absolute times keep the window
 * comparison deterministic.
 */
export default scenario({
  lane: "live-only",
  id: "reminder-daily-recurrence-outcome",
  title: "A daily reminder fires on consecutive days",
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
      title: "LifeOps Daily Recurrence",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed a daily morning reminder",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Take morning meds",
        timezone: "UTC",
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
      name: "process inside day 1 morning window",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "2027-01-15T11:30:00.000Z", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
    {
      kind: "api",
      name: "process inside day 2 morning window — recurs",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "2027-01-16T11:30:00.000Z", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
  ],
});
