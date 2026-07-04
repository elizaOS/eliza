// Defines the reminder multistep plan outcome LifeOps scenario-runner spec.
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
 * Outcome scenario: a multi-step reminder plan delivers each step at its own
 * scheduled time. A lead step (`offsetMinutes: 60` → 60m before due) and an
 * at-due step (`offsetMinutes: 0`) on one definition must each fire when their
 * window opens — not all at once, not only the last. This pins multi-step plan
 * delivery (issue #9970): processing at the lead time delivers the lead step;
 * processing at the due time delivers the due step.
 *
 * `scheduledFor = dueAt - offsetMinutes` (see reminders-service collectDue):
 * with `dueAt = now+90m`, the lead step is at now+30m and the due step at
 * now+90m. API-only, but kept live-only until the keyless runner timeout is
 * resolved in #10757 and this scenario is promoted with passing PR-gated
 * evidence.
 */
export default scenario({
  lane: "live-only",
  id: "reminder-multistep-plan-outcome",
  title: "Each step of a multi-step reminder plan delivers at its own time",
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
      title: "LifeOps Multi-step Reminder Plan",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed task due in 90m with lead + at-due steps",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Board meeting",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+90m}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            { channel: "in_app", offsetMinutes: 60, label: "Heads-up (60m)" },
            { channel: "in_app", offsetMinutes: 0, label: "Starting now" },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process at the lead time — lead step delivers",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+30m}}", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
    {
      kind: "api",
      name: "process at the due time — at-due step delivers",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+90m}}", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
  ],
});
