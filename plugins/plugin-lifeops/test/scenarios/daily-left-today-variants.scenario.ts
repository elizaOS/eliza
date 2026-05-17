import { scenario } from "@elizaos/scenario-schema";

/**
 * `assertResponse` helper mirroring the legacy JSON fields
 * `apiResponseIncludesAll`, `apiResponseIncludesAny`, and `apiResponseExcludes`.
 * The new `ApiTurn` schema does not have those fields; the closest fit is a
 * custom predicate that serializes the body and runs substring checks.
 */
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
  id: "daily-left-today-variants",
  title: "Daily leftover overview phrasing variants",
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
      title: "LifeOps Daily Left Today Discord",
    },
    {
      id: "telegram",
      source: "telegram",
      title: "LifeOps Daily Left Today Telegram",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed pay rent",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Pay rent",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+45m}}",
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
      name: "seed call mom",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Call mom",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+25m}}",
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
      kind: "message",
      name: "overview variant one",
      room: "discord",
      text: "what life ops tasks are still left for today?",
      plannerIncludesAll: ["life", "overview"],
      plannerExcludes: ["reply"],
      responseIncludesAll: ["pay rent", "call mom"],
    },
    {
      kind: "api",
      name: "complete call mom",
      method: "POST",
      path: "/api/lifeops/occurrences/{{occurrenceId:Call mom}}/complete",
      body: {
        note: "finished during live lifecycle coverage",
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({ includesAll: ["completed"] }),
    },
    {
      kind: "api",
      name: "api overview after completion",
      method: "GET",
      path: "/api/lifeops/overview",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["Pay rent"],
        excludes: ["Call mom"],
      }),
    },
    {
      kind: "message",
      name: "overview variant two",
      room: "telegram",
      text: "what do i still need to do today in life ops?",
      plannerIncludesAll: ["life", "overview"],
      plannerExcludes: ["reply"],
      responseIncludesAll: ["pay rent"],
      responseExcludes: ["call mom"],
    },
    {
      kind: "api",
      name: "api overview before final follow-up",
      method: "GET",
      path: "/api/lifeops/overview",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["Pay rent"],
        excludes: ["Call mom"],
      }),
    },
    {
      kind: "message",
      name: "overview variant three",
      room: "discord",
      text: "anything else in my life ops list i need to get done today?",
      plannerIncludesAll: ["life", "overview"],
      plannerExcludes: ["reply"],
      responseIncludesAny: ["pay rent", "rent"],
      responseExcludes: ["call mom"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Pay rent",
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Call mom",
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
  ],
});
