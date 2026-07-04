// Defines the reminder dst boundary outcome LifeOps scenario-runner spec.
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
 * Outcome scenario: a daily reminder's window tracks local time across a DST
 * transition. A `daily` morning reminder (local 05:00–12:00) in
 * America/New_York is processed on either side of the 2027-03-14 US
 * spring-forward. The post-transition turn is at `09:30Z`, which is local 05:30
 * under EDT (UTC−4, inside the morning window) but would be local 04:30 under
 * EST (UTC−5, outside it). Delivery on that turn proves the window honors the
 * DST offset rather than a fixed UTC offset (issue #9970 DST-boundary edge case).
 */
export default scenario({
  lane: "live-only",
  id: "reminder-dst-boundary-outcome",
  title: "A daily reminder window tracks local time across a DST transition",
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
      title: "LifeOps DST Boundary",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed a daily morning reminder in America/New_York",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Morning stretch",
        timezone: "America/New_York",
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
      name: "process before DST (EST) inside the local morning window",
      method: "POST",
      // 13:00Z = 08:00 local under EST (UTC−5), inside morning.
      path: "/api/lifeops/reminders/process",
      body: { now: "2027-03-13T13:00:00.000Z", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
    {
      kind: "api",
      name: "process after DST (EDT) — only inside the window if DST is honored",
      method: "POST",
      // 09:30Z = 05:30 local under EDT (UTC−4, inside morning); it would be
      // 04:30 under EST (outside), so delivery proves the DST offset is applied.
      path: "/api/lifeops/reminders/process",
      body: { now: "2027-03-15T09:30:00.000Z", limit: 10 },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
  ],
});
