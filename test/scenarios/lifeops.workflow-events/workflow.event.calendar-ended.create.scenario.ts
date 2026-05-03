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
  id: "workflow.event.calendar-ended.create",
  title: "Create an event-triggered workflow for calendar event end",
  domain: "lifeops.workflow-events",
  tags: ["lifeops", "workflow", "event-trigger"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Workflow event trigger",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create event-triggered workflow",
      method: "POST",
      path: "/api/lifeops/workflows",
      body: {
        title: "Post-meeting summary",
        triggerType: "event",
        schedule: {
          kind: "event",
          eventKind: "calendar.event.ended",
          filters: {
            calendarIds: ["primary"],
            titleIncludesAny: ["sync", "standup", "review"],
            minDurationMinutes: 10,
          },
        },
        actionPlan: {
          steps: [
            {
              kind: "summarize",
              prompt: "Summarize the just-ended meeting in 3 bullets.",
            },
          ],
        },
      },
      expectedStatus: 201,
      assertResponse: assertApiBody({
        includesAll: [
          '"triggerType":"event"',
          '"kind":"event"',
          '"eventKind":"calendar.event.ended"',
        ],
      }),
    },
    {
      kind: "api",
      name: "list workflows includes event trigger",
      method: "GET",
      path: "/api/lifeops/workflows",
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["Post-meeting summary", "calendar.event.ended"],
      }),
    },
  ],
});
