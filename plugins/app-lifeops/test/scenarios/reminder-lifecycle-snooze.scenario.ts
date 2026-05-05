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
  id: "reminder-lifecycle-snooze",
  title: "Compressed reminder lifecycle with snooze",
  domain: "lifeops",
  tags: ["lifeops", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "discord",
      source: "discord",
      title: "LifeOps Reminder Snooze Discord",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed call dentist",
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
      name: "snooze reminder through chat",
      room: "discord",
      text: "snooze call dentist for 30 minutes",
      plannerIncludesAll: ["life", "snooze"],
      responseIncludesAny: ["30", "snooze", "later"],
    },
    {
      kind: "api",
      name: "api overview after snooze",
      method: "GET",
      path: "/api/lifeops/overview",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["Call dentist", "snoozed"],
      }),
    },
    {
      kind: "api",
      name: "process reminders before snooze expires",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+20m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
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
