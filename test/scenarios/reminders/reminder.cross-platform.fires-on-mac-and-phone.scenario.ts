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
  id: "reminder.cross-platform.fires-on-mac-and-phone",
  title: "Reminder ladder fires across all three rungs before acknowledgement",
  domain: "reminders",
  tags: ["reminders", "lifeops", "cross-platform", "ladder"],
  description:
    "Deterministic ladder control for the Mac + phone reminder case. The scenario proves three reminder rungs all fire before any acknowledgement; device-bus fan-out is covered by the real intent-sync and device-bus tests.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "api",
      name: "seed meeting ladder reminder",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Take meds",
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
              label: "First rung",
            },
            {
              channel: "in_app",
              offsetMinutes: 30,
              label: "Second rung",
            },
            {
              channel: "in_app",
              offsetMinutes: 60,
              label: "Third rung",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "process first rung",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+10m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered", '"stepIndex":0'],
      }),
    },
    {
      kind: "api",
      name: "process second rung",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+40m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered", '"stepIndex":1'],
      }),
    },
    {
      kind: "api",
      name: "process third rung",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+70m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered", '"stepIndex":2'],
      }),
    },
    {
      kind: "api",
      name: "inspect three rung reminder ladder",
      method: "GET",
      path: "/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:Take meds}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ['"stepIndex":0', '"stepIndex":1', '"stepIndex":2'],
        excludes: ["blocked_acknowledged"],
      }),
    },
  ],
});
