// Defines the reminder not yet due outcome LifeOps scenario-runner spec.
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
 * Outcome scenario: a reminder does not fire early. Processing the dispatch
 * queue *before* a step's scheduled time produces no attempts; processing it
 * at the scheduled time then delivers. This pins the timing gate (issue #9970)
 * so a clock skew or an over-eager tick can't deliver a reminder ahead of its
 * window — only outcome assertions on the produced attempts catch that.
 *
 * API-only, but kept live-only until the keyless runner timeout is resolved in
 * #10757 and this scenario is promoted with passing PR-gated evidence.
 */
export default scenario({
  lane: "live-only",
  id: "reminder-not-yet-due-outcome",
  title: "A reminder is not delivered before its scheduled time",
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
      title: "LifeOps Reminder Not Yet Due",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed reminder due in 30m",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Leave for the airport",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+30m}}",
          // Lead 0 so the step's deliverable window opens at `dueAt`, not
          // `dueAt - lead`; this scenario is specifically about the timing gate.
          visibilityLeadMinutes: 0,
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
      name: "process 10m before due — nothing fires",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+20m}}", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
    },
    {
      kind: "api",
      name: "process at due time — now it delivers",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: { now: "{{now+30m}}", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
  ],
});
