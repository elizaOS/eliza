/** Proves that angry, explicitly temporary pushback skips the active occurrence, preserves its definition, and suppresses the later due rung. */
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
  id: "reminder.escalation.user-angry",
  title: "User tells agent to stop; agent de-escalates without disabling",
  domain: "reminders",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "reminders", "escalation", "cancel-mid-flow"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "discord",
      source: "discord",
      title: "Reminders Escalation User Angry",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed pushy task",
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
              label: "Follow-up reminder",
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
      name: "user snaps at reminder",
      room: "discord",
      text: "Stop pinging me about the dentist for today, enough already!",
      plannerIncludesAll: ["<name>life</name>"],
      responseIncludesAny: ["sorry", "okay", "back off", "calm", "quieter"],
      responseExcludes: ["disabled", "deleted"],
      responseJudge: {
        rubric:
          "Agent acknowledges the user's frustration, offers to soften or pause future nudges without fully deleting or disabling the reminder.",
        minimumScore: 0.6,
      },
    },
    {
      kind: "api",
      name: "process later rung after pushback",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
    },
    {
      kind: "api",
      name: "definition still exists after pushback",
      method: "GET",
      path: "/api/lifeops/definitions/{{definitionId:Call dentist}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["Call dentist"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "angry-pushback-skips-active-occurrence",
      predicate: (ctx) => {
        const turn = ctx.turns?.find(
          (entry) => entry.name === "user snaps at reminder",
        );
        const life = turn?.actionsCalled.find(
          (action) => action.actionName === "LIFE",
        );
        if (!life || life.error || life.result?.success !== true) {
          return "expected LIFE to apply a successful temporary skip";
        }
        const data =
          life.result.data && typeof life.result.data === "object"
            ? (life.result.data as Record<string, unknown>)
            : null;
        if (data?.state !== "skipped" || data.title !== "Call dentist") {
          return `expected skipped Call dentist occurrence, saw ${JSON.stringify(data)}`;
        }
        if (data.deleted !== undefined) {
          return "temporary pushback deleted the reminder definition";
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
