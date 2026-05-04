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
  id: "reminder.escalation.silent-dismiss",
  title: "User silently dismisses reminders and escalation continues",
  domain: "reminders",
  tags: ["lifeops", "reminders", "escalation", "permission-denied"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "discord",
      source: "discord",
      title: "Reminders Escalation Silent Dismiss",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed silent task",
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
            {
              channel: "in_app",
              offsetMinutes: 60,
              label: "Urgent reminder",
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
      kind: "api",
      name: "process second reminder ignored",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered"] }),
    },
    {
      kind: "api",
      name: "process third reminder still escalating",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+70m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["delivered"] }),
    },
    {
      kind: "api",
      name: "inspect reminder lifecycle after silent dismiss",
      method: "GET",
      path: "/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:Call dentist}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered"],
        excludes: ["acknowledged"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "reminderIntensity",
      title: "Call dentist",
      expected: "escalated",
    },
  ],
});
