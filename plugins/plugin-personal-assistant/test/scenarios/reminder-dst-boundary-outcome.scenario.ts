/** Proves a local morning reminder moves by one UTC hour across the New York spring-forward transition. */
import { scenario } from "@elizaos/scenario-runner/schema";

const TITLE = "Morning stretch DST contract";

function assertSingleDelivery(
  expectedScheduledFor: string,
): (_status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const attempts =
      body &&
      typeof body === "object" &&
      Array.isArray((body as { attempts?: unknown }).attempts)
        ? (body as { attempts: unknown[] }).attempts
        : null;
    if (!attempts)
      return `expected attempts array, saw ${JSON.stringify(body)}`;
    const matching = attempts.filter((attempt) => {
      if (!attempt || typeof attempt !== "object") return false;
      const row = attempt as {
        deliveryMetadata?: { title?: unknown; lifecycle?: unknown };
      };
      return (
        row.deliveryMetadata?.title === TITLE &&
        row.deliveryMetadata.lifecycle === "plan"
      );
    });
    if (matching.length !== 1)
      return `expected exactly one ${TITLE} plan attempt, saw ${matching.length}`;
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
    if (row.scheduledFor !== expectedScheduledFor) {
      return `expected local-window start ${expectedScheduledFor}, saw ${String(row.scheduledFor)}`;
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
  lane: "pr-deterministic",
  id: "reminder-dst-boundary-outcome",
  title: "A daily reminder window tracks local time across a DST transition",
  domain: "reminders",
  evidenceScope: "domain-contract",
  tags: ["pr", "deterministic", "lifeops", "reminders", "dst"],
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
        title: TITLE,
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
      assertResponse: assertSingleDelivery("2027-03-13T10:00:00.000Z"),
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
      assertResponse: assertSingleDelivery("2027-03-15T09:00:00.000Z"),
    },
  ],
});
