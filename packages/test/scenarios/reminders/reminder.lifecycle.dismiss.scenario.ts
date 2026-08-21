/**
 * Exercises a real reminder occurrence through delivery, an explicit LIFE
 * skip/dismiss transition, and suppression of a later due escalation rung.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

function assertApiBody(options: {
  includesAll?: ReadonlyArray<string>;
  includesAny?: ReadonlyArray<string>;
  excludes?: ReadonlyArray<string>;
}): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const serialized =
      typeof body === "string" ? body : JSON.stringify(body ?? "");
    if (options.includesAll) {
      for (const needle of options.includesAll) {
        if (!serialized.includes(needle)) {
          return `expected body to include "${needle}"`;
        }
      }
    }
    if (options.includesAny && options.includesAny.length > 0) {
      const ok = options.includesAny.some((needle) =>
        serialized.includes(needle),
      );
      if (!ok) {
        return `expected body to include any of ${options.includesAny.join(", ")}`;
      }
    }
    if (options.excludes) {
      for (const needle of options.excludes) {
        if (serialized.includes(needle)) {
          return `expected body to exclude "${needle}"`;
        }
      }
    }
  };
}

export default scenario({
  lane: "live-only",
  id: "reminder.lifecycle.dismiss",
  title: "User dismisses a reminder without completing the task",
  domain: "reminders",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "reminders", "cancel-mid-flow"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "discord",
      source: "discord",
      title: "Reminders Lifecycle Dismiss Discord",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed dismissable task",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Call dentist",
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
            {
              channel: "in_app",
              offsetMinutes: 0,
              label: "In-app reminder",
            },
            {
              channel: "in_app",
              offsetMinutes: 30,
              label: "Later in-app reminder",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process first reminder",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+10m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered", "in_app"] }),
    },
    {
      kind: "message",
      name: "dismiss reminder through chat",
      room: "discord",
      text: "Skip Call dentist for today.",
      plannerIncludesAll: ["<name>life</name>"],
      responseIncludesAny: ["skip", "skipping", "okay", "got it"],
    },
    {
      kind: "api",
      name: "process reminders after dismiss",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "dismiss-transition-is-skipped-occurrence",
      predicate: (ctx) => {
        const dismissTurn = ctx.turns?.find(
          (turn) => turn.name === "dismiss reminder through chat",
        );
        const life = dismissTurn?.actionsCalled.find(
          (action) => action.actionName === "LIFE",
        );
        if (!life || life.error || life.result?.success !== true) {
          return "expected a successful LIFE skip transition on the dismiss turn";
        }
        const data =
          life.result.data && typeof life.result.data === "object"
            ? (life.result.data as Record<string, unknown>)
            : null;
        if (data?.state !== "skipped") {
          return `expected occurrence state=skipped, saw ${String(data?.state)}`;
        }
        if (data.title !== "Call dentist") {
          return `expected the Call dentist occurrence, saw ${String(data.title)}`;
        }
      },
    },
    {
      type: "definitionCountDelta",
      title: "Call dentist",
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
  ],
});
