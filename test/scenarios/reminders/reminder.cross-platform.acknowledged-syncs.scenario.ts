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
  id: "reminder.cross-platform.acknowledged-syncs",
  title: "Acknowledging one rung suppresses the remaining ladder",
  domain: "reminders",
  tags: ["reminders", "lifeops", "cross-platform", "acknowledgement"],
  description:
    "Deterministic acknowledgement control for the cross-device ladder case. The scenario proves the first rung fires, the owner acknowledges it, and later rungs no longer dispatch; device-bus sync itself is covered by the real intent-sync ladder tests.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "api",
      name: "seed acknowledged ladder reminder",
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
      name: "process first rung before acknowledgement",
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
      name: "acknowledge first rung",
      method: "POST",
      path: "/api/lifeops/reminders/acknowledge",
      body: {
        ownerType: "occurrence",
        ownerId: "{{occurrenceId:Take meds}}",
        acknowledgedAt: "{{now+11m}}",
        note: "saw it on my Mac",
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["ok"] }),
    },
    {
      kind: "api",
      name: "process second rung after acknowledgement",
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
      name: "process third rung after acknowledgement",
      method: "POST",
      path: "/api/lifeops/reminders/process",
      body: {
        now: "{{now+70m}}",
        limit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ['"attempts":[]'] }),
    },
    {
      kind: "api",
      name: "inspect acknowledged reminder ladder",
      method: "GET",
      path: "/api/lifeops/reminders/inspection?ownerType=occurrence&ownerId={{occurrenceId:Take meds}}",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["delivered", '"stepIndex":0'],
        excludes: ["blocked_acknowledged"],
      }),
    },
  ],
});
