// Defines the reminder idempotent retry outcome LifeOps scenario-runner spec.
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
 * Outcome scenario: a once reminder fires exactly once. Re-running the
 * dispatch processor at the same instant after a successful delivery must not
 * re-deliver — the second pass produces no attempts. This pins the
 * idempotent-retry / no-double-send guarantee (issue #9970 edge-case list):
 * a retry, restart, or duplicate tick can't double-notify the owner.
 *
 * API-only, but kept live-only until the keyless runner timeout is resolved in
 * #10757 and this scenario is promoted with passing PR-gated evidence.
 */
export default scenario({
  lane: "live-only",
  id: "reminder-idempotent-retry-outcome",
  title: "Re-processing a delivered reminder does not double-send",
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
        title: "Submit timesheet",
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
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
    {
      kind: "api",
      name: "re-process at the same instant — no double-send",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+10m}}", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
    },
  ],
});
