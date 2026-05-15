import { scenario } from "@elizaos/scenario-schema";

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
  id: "workflow.event.calendar-ended.filter-mismatch",
  title: "Event-triggered workflow does not fire when filters reject the event",
  domain: "lifeops.workflow-events",
  tags: ["lifeops", "workflow", "event-trigger"],
  isolation: "per-scenario",
  seed: [
    {
      type: "custom",
      name: "seed-past-event-with-nonmatching-title",
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
        const endAt = new Date(now - 2 * 60_000).toISOString();
        const startAt = new Date(now - 20 * 60_000).toISOString();
        await service.repository.upsertCalendarEvent({
          id: "seed_calendar_event_2",
          externalId: "seed_external_2",
          agentId: service.agentId(),
          provider: "google",
          side: "owner",
          calendarId: "primary",
          title: "Coffee with friend",
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
      title: "Calendar event-ended filter mismatch",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create workflow with title filter that won't match",
      method: "POST",
      path: "/api/lifeops/workflows",
      body: {
        title: "Work-meeting post-processor",
        triggerType: "event",
        schedule: {
          kind: "event",
          eventKind: "calendar.event.ended",
          filters: {
            titleIncludesAny: ["standup", "review", "1:1"],
          },
        },
        actionPlan: {
          steps: [
            {
              kind: "summarize",
              prompt: "Summarize the work meeting.",
            },
          ],
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "tick",
      name: "tick scheduler — workflow should NOT fire",
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
          return `expected no runs because title filter rejected the event, got ${inner}`;
        }
        return undefined;
      },
    },
  ],
});
