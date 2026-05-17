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
  id: "reminder-lifecycle-ack-complete",
  title: "Compressed reminder lifecycle with ack and completion",
  domain: "lifeops",
  tags: ["lifeops"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "discord",
      source: "discord",
      title: "LifeOps Reminder Lifecycle Discord",
    },
    {
      id: "telegram",
      source: "telegram",
      title: "LifeOps Reminder Lifecycle Telegram",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed lifecycle call dentist",
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
      kind: "api",
      name: "acknowledge delivered reminder",
      method: "POST",
      path: "/api/lifeops/reminders/acknowledge",
      body: {
        ownerType: "occurrence",
        ownerId: "{{occurrenceId:Call dentist}}",
        acknowledgedAt: "{{now+11m}}",
        note: "seen already",
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["ok"] }),
    },
    {
      kind: "api",
      name: "process follow-up reminder after acknowledgement",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+41m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
    },
    {
      kind: "api",
      name: "inspect reminder lifecycle",
      method: "GET",
      path: "/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:Call dentist}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered", "reminder_delivered"],
        excludes: ["blocked_acknowledged"],
      }),
    },
    {
      kind: "message",
      name: "overview before completion",
      room: "discord",
      text: "what life ops tasks are still left for today?",
      plannerIncludesAll: ["life", "overview"],
      responseIncludesAny: ["call dentist", "call the dentist"],
    },
    {
      kind: "api",
      name: "complete call dentist after acknowledgement",
      method: "POST",
      path: "/api/lifeops/occurrences/{{occurrenceId:Call dentist}}/complete",
      body: {
        note: "done after the reminder fired",
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["completed"] }),
    },
    {
      kind: "api",
      name: "definition performance after completion",
      method: "GET",
      path: "/api/lifeops/definitions/{{definitionId:Call dentist}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["totalCompletedCount", "1", "currentOccurrenceStreak"],
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
