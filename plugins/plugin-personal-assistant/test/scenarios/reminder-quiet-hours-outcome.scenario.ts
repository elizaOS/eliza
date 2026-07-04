// Defines the reminder quiet hours outcome LifeOps scenario-runner spec.
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
 * Outcome scenario: a reminder on an interruptive channel is suppressed during
 * quiet hours. Quiet hours gate non-`in_app` channels (`isWithinQuietHours`),
 * so an `sms` step processed inside the window yields a `blocked_quiet_hours`
 * delivery outcome rather than notifying the owner. Pins the quiet-hours
 * suppression edge case (issue #9970).
 *
 * Uses absolute times so the minute-of-day comparison is deterministic
 * (`{{now}}` is wall-clock and can't be pinned). The window is 00:00–06:00 UTC;
 * processing at 03:00 UTC lands inside it.
 */
export default scenario({
  lane: "live-only",
  id: "reminder-quiet-hours-outcome",
  title: "An interruptive reminder is suppressed during quiet hours",
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
      title: "LifeOps Reminder Quiet Hours",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed sms reminder inside a quiet-hours window",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Confirm dinner reservation",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "2027-01-15T03:00:00.000Z",
          visibilityLeadMinutes: 0,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [{ channel: "sms", offsetMinutes: 0, label: "SMS reminder" }],
          quietHours: {
            timezone: "UTC",
            startMinute: 0,
            endMinute: 360,
            channels: ["sms"],
          },
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process at 03:00 UTC — suppressed by quiet hours",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "2027-01-15T03:00:00.000Z", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["blocked_quiet_hours"] }),
    },
  ],
});
