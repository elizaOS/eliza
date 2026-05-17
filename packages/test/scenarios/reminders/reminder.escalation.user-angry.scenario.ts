import { scenario } from "@elizaos/scenario-schema";

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
  id: "reminder.escalation.user-angry",
  title: "User tells agent to stop; agent de-escalates without disabling",
  domain: "reminders",
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
      text: "stop pinging me about the dentist, enough already!",
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
      type: "definitionCountDelta",
      title: "Call dentist",
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
  ],
});
