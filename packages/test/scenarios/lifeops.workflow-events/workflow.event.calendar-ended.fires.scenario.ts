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

interface RepositoryLike {
  upsertCalendarEvent: (event: Record<string, unknown>) => Promise<void>;
}

interface LifeOpsServiceLike {
  repository: RepositoryLike;
  agentId: () => string;
}

interface RuntimeLike {
  getService?: (serviceType: string) => unknown;
}

export default scenario({
  id: "workflow.event.calendar-ended.fires",
  title:
    "Event-triggered workflow fires when a synced event's end time has passed",
  domain: "lifeops.workflow-events",
  tags: ["lifeops", "workflow", "event-trigger"],
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "seed-past-calendar-event",
      apply: async (ctx) => {
        const runtime = ctx.runtime as RuntimeLike;
        const service = runtime.getService?.("lifeops") as
          | LifeOpsServiceLike
          | undefined;
        if (!service) {
          return "LifeOps service is not registered on the runtime";
        }
        const now =
          typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
            ? Date.parse(ctx.now)
            : Date.now();
        const endAt = new Date(now - 5 * 60_000).toISOString();
        const startAt = new Date(now - 35 * 60_000).toISOString();
        await service.repository.upsertCalendarEvent({
          id: "seed_calendar_event_1",
          externalId: "seed_external_1",
          agentId: service.agentId(),
          provider: "google",
          side: "owner",
          calendarId: "primary",
          title: "Quarterly review",
          description: "",
          location: "",
          status: "confirmed",
          startAt,
          endAt,
          isAllDay: false,
          timezone: "UTC",
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: {},
          syncedAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Calendar event-ended workflow",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create event-triggered workflow",
      method: "POST",
      path: "/api/lifeops/workflows",
      body: {
        title: "After quarterly review",
        triggerType: "event",
        schedule: {
          kind: "event",
          eventKind: "calendar.event.ended",
        },
        actionPlan: {
          steps: [
            {
              kind: "summarize",
              prompt: "Note that the meeting ended.",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "tick",
      name: "tick the scheduler so the event fires",
      worker: "lifeops_scheduler",
      options: {
        now: "{{now}}",
        workflowLimit: 10,
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["workflowRuns", "success"],
      }),
    },
    {
      kind: "tick",
      name: "second tick does not re-fire for the same event",
      worker: "lifeops_scheduler",
      options: {
        now: "{{now}}",
        workflowLimit: 10,
      },
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const serialized =
          typeof body === "string" ? body : JSON.stringify(body ?? "");
        const match = serialized.match(/"workflowRuns":\[(.*?)\]/);
        if (!match) {
          return "expected workflowRuns field in response";
        }
        const inner = match[1]?.trim() ?? "";
        if (inner.length > 0) {
          return `expected second tick to yield no workflow runs, got ${inner}`;
        }
        return undefined;
      },
    },
  ],
});
