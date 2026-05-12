import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioCheckResult,
  ScenarioContext,
} from "@elizaos/scenario-schema";
import { insertActivityEvent } from "../../../plugins/app-lifeops/src/activity-profile/activity-tracker-repo.ts";
import {
  recordBrowserFocusWindow,
  recordBrowserSessionRegistration,
} from "../../../plugins/app-lifeops/src/lifeops/browser-extension-store.ts";
import {
  type LifeOpsMeetingPreferencesPatch,
  updateLifeOpsMeetingPreferences,
} from "../../../plugins/app-lifeops/src/lifeops/owner-profile.ts";
import {
  createLifeOpsCalendarSyncState,
  LifeOpsRepository,
} from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { LifeOpsService } from "../../../plugins/app-lifeops/src/lifeops/service.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

type CalendarSeedEvent = {
  id: string;
  title: string;
  startOffsetMinutes: number;
  durationMinutes: number;
  attendees?: string[];
  description?: string;
  location?: string;
  metadata?: Record<string, unknown>;
};

type BrowserTelemetryWindow = {
  url: string;
  offsetMinutes: number;
  durationMinutes: number;
};

type BrowserTelemetrySeed = {
  deviceId: string;
  browserVendor?: "chrome" | "safari" | "unknown";
  extensionVersion?: string;
  userAgent?: string;
  windows: BrowserTelemetryWindow[];
};

type BrowserPageContextSeed = {
  browser: "chrome" | "safari";
  profileId: string;
  windowId: string;
  tabId: string;
  url: string;
  title: string;
  selectionText?: string | null;
  mainText?: string | null;
  headings?: string[];
  links?: Array<{ text: string; href: string }>;
  forms?: Array<{ action: string | null; fields: string[] }>;
  metadata?: Record<string, unknown>;
};

type ScreenTimeSeedSession = {
  source: "app" | "website";
  identifier: string;
  displayName?: string;
  offsetMinutes: number;
  durationMinutes: number;
  metadata?: Record<string, unknown>;
};

type ActivityEventSeed = {
  offsetMinutes: number;
  eventKind: "activate" | "deactivate";
  bundleId: string;
  appName: string;
  windowTitle?: string | null;
};

type LifeOpsDefinitionSeed = {
  kind: "task" | "habit" | "routine";
  title: string;
};

type LifeOpsGoalSeed = {
  title: string;
};

function requireRuntime(ctx: ScenarioContext): IAgentRuntime | string {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  return runtime ?? "scenario runtime unavailable during seed";
}

function scenarioNow(ctx: ScenarioContext): Date {
  return typeof ctx.now === "string" && Number.isFinite(Date.parse(ctx.now))
    ? new Date(ctx.now)
    : new Date();
}

const NOW_TEMPLATE_RE = /^\{\{now(?:([+-])(\d+)([mhdw]))?\}\}$/;

function resolveScenarioIsoDate(value: string, ctx: ScenarioContext): string {
  const trimmed = value.trim();
  const match = NOW_TEMPLATE_RE.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const now = scenarioNow(ctx);
  const [, sign, amountRaw, unitRaw] = match;
  if (!sign || !amountRaw || !unitRaw) {
    return now.toISOString();
  }
  const amount = Number.parseInt(amountRaw, 10);
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
    w: 7 * 24 * 60 * 60_000,
  };
  const multiplier = multipliers[unitRaw.toLowerCase()];
  const delta = amount * multiplier * (sign === "-" ? -1 : 1);
  return new Date(now.getTime() + delta).toISOString();
}

export function seedMeetingPreferences(patch: LifeOpsMeetingPreferencesPatch) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }
    const updated = await updateLifeOpsMeetingPreferences(runtime, patch);
    return updated ? undefined : "failed to seed meeting preferences";
  };
}

export function seedCalendarCache(args: {
  events: CalendarSeedEvent[];
  windowDaysAhead?: number;
}) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    await seedGoogleConnectorGrant(runtime, {
      capabilities: ["google.calendar.read", "google.calendar.write"],
    });

    const repository = new LifeOpsRepository(runtime);
    const agentId = String(runtime.agentId);
    const now = scenarioNow(ctx);
    const nowIso = now.toISOString();

    for (const event of args.events) {
      const startAt = new Date(
        now.getTime() + event.startOffsetMinutes * 60_000,
      ).toISOString();
      const endAt = new Date(
        now.getTime() +
          (event.startOffsetMinutes + event.durationMinutes) * 60_000,
      ).toISOString();
      await repository.upsertCalendarEvent({
        id: event.id,
        externalId: `${event.id}-external`,
        agentId,
        provider: "google",
        side: "owner",
        calendarId: "primary",
        title: event.title,
        description: event.description ?? "",
        location: event.location ?? "",
        status: "confirmed",
        startAt,
        endAt,
        isAllDay: false,
        timezone: "America/Los_Angeles",
        htmlLink: null,
        conferenceLink: null,
        organizer: null,
        attendees: (event.attendees ?? []).map((email) => ({
          email,
          displayName: null,
          responseStatus: null,
          self: false,
          organizer: false,
          optional: false,
        })),
        metadata: event.metadata ?? {},
        syncedAt: nowIso,
        updatedAt: nowIso,
      });
    }

    await repository.upsertCalendarSyncState(
      createLifeOpsCalendarSyncState({
        agentId,
        provider: "google",
        side: "owner",
        calendarId: "primary",
        windowStartAt: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
        windowEndAt: new Date(
          now.getTime() + (args.windowDaysAhead ?? 7) * 24 * 60 * 60_000,
        ).toISOString(),
        syncedAt: nowIso,
      }),
    );

    return undefined;
  };
}

export function seedBrowserExtensionTelemetry(args: BrowserTelemetrySeed) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    const now = scenarioNow(ctx);
    await recordBrowserSessionRegistration(runtime, {
      deviceId: args.deviceId,
      userAgent:
        args.userAgent ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AgentBrowserBridge/1.0",
      extensionVersion: args.extensionVersion ?? "1.0.0",
      browserVendor: args.browserVendor ?? "chrome",
      registeredAt: now.toISOString(),
    });

    for (const window of args.windows) {
      const windowEnd = new Date(now.getTime() - window.offsetMinutes * 60_000);
      const windowStart = new Date(
        windowEnd.getTime() - window.durationMinutes * 60_000,
      );
      const recorded = await recordBrowserFocusWindow(runtime, {
        deviceId: args.deviceId,
        url: window.url,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
      if (!recorded) {
        return `failed to record browser focus window for ${window.url}`;
      }
    }

    return undefined;
  };
}

export function seedBrowserCurrentPageContext(args: BrowserPageContextSeed) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    await LifeOpsRepository.bootstrapSchema(runtime);

    const nowIso = scenarioNow(ctx).toISOString();
    const service = new LifeOpsService(runtime);
    await service.updateBrowserSettings({
      enabled: true,
      allowBrowserControl: true,
    });

    const syncResult = await service.syncBrowserState({
      companion: {
        browser: args.browser,
        profileId: args.profileId,
        profileLabel: args.profileId,
        label: `Agent Browser Bridge ${args.browser} ${args.profileId}`,
        connectionState: "connected",
        permissions: {
          tabs: true,
          scripting: true,
          activeTab: true,
          allOrigins: true,
          grantedOrigins: [new URL(args.url).origin],
          incognitoEnabled: false,
        },
      },
      tabs: [
        {
          browser: args.browser,
          profileId: args.profileId,
          windowId: args.windowId,
          tabId: args.tabId,
          url: args.url,
          title: args.title,
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
          lastSeenAt: nowIso,
          lastFocusedAt: nowIso,
        },
      ],
      pageContexts: [
        {
          browser: args.browser,
          profileId: args.profileId,
          windowId: args.windowId,
          tabId: args.tabId,
          url: args.url,
          title: args.title,
          selectionText: args.selectionText ?? null,
          mainText: args.mainText ?? null,
          headings: args.headings ?? [],
          links: args.links ?? [],
          forms: args.forms ?? [],
          capturedAt: nowIso,
          metadata: args.metadata ?? {},
        },
      ],
    });

    const currentPage = syncResult.currentPage;
    if (!currentPage) {
      return "failed to seed current browser page context";
    }
    if (currentPage.url !== args.url) {
      return `seeded current browser page context mismatch: expected ${args.url}, got ${currentPage.url}`;
    }
    if (currentPage.title !== args.title) {
      return `seeded current browser page context title mismatch: expected ${args.title}, got ${currentPage.title}`;
    }

    return undefined;
  };
}

export function seedScreenTimeSessions(args: {
  sessions: ScreenTimeSeedSession[];
}) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    const service = new LifeOpsService(runtime);
    const now = scenarioNow(ctx);
    for (const session of args.sessions) {
      const endAt = new Date(now.getTime() - session.offsetMinutes * 60_000);
      const startAt = new Date(
        endAt.getTime() - session.durationMinutes * 60_000,
      );
      await service.recordScreenTimeEvent({
        source: session.source,
        identifier: session.identifier,
        displayName: session.displayName ?? session.identifier,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        durationSeconds: Math.round(session.durationMinutes * 60),
        metadata: session.metadata ?? {},
      });
    }

    return undefined;
  };
}

export function seedActivityEvents(args: { events: ActivityEventSeed[] }) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    const now = scenarioNow(ctx);
    const agentId = String(runtime.agentId);
    for (const event of args.events) {
      const observedAt = new Date(
        now.getTime() - event.offsetMinutes * 60_000,
      ).toISOString();
      await insertActivityEvent(runtime, {
        agentId,
        observedAt,
        eventKind: event.eventKind,
        bundleId: event.bundleId,
        appName: event.appName,
        windowTitle: event.windowTitle ?? null,
      });
    }

    return undefined;
  };
}

export function seedLifeOpsDefinition(args: LifeOpsDefinitionSeed) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    await LifeOpsRepository.bootstrapSchema(runtime);

    const agentId = String(runtime.agentId);
    const nowIso = scenarioNow(ctx).toISOString();
    const slug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await executeRawSql(
      runtime,
      `INSERT INTO life_task_definitions (
         id, agent_id, subject_id, kind, title, created_at, updated_at
       ) VALUES (
         ${sqlQuote(`seed-def-${slug}`)},
         ${sqlQuote(agentId)},
         ${sqlQuote(agentId)},
         ${sqlQuote(args.kind)},
         ${sqlQuote(args.title)},
         ${sqlQuote(nowIso)},
         ${sqlQuote(nowIso)}
       )`,
    );

    return undefined;
  };
}

export function seedLifeOpsGoal(args: LifeOpsGoalSeed) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    await LifeOpsRepository.bootstrapSchema(runtime);

    const agentId = String(runtime.agentId);
    const nowIso = scenarioNow(ctx).toISOString();
    const slug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await executeRawSql(
      runtime,
      `INSERT INTO life_goal_definitions (
         id, agent_id, subject_id, title, status, review_state, created_at, updated_at
       ) VALUES (
         ${sqlQuote(`seed-goal-${slug}`)},
         ${sqlQuote(agentId)},
         ${sqlQuote(agentId)},
         ${sqlQuote(args.title)},
         'active',
         'needs_attention',
         ${sqlQuote(nowIso)},
         ${sqlQuote(nowIso)}
       )`,
    );

    return undefined;
  };
}

export function seedCheckinDefinition(args: {
  id: string;
  title: string;
  dueAt: string;
  kind?: "task" | "habit" | "routine";
  state?: "pending" | "active" | "in_progress" | "completed";
}) {
  return async (ctx: ScenarioContext): Promise<ScenarioCheckResult> => {
    const runtime = requireRuntime(ctx);
    if (typeof runtime === "string") {
      return runtime;
    }

    await LifeOpsRepository.bootstrapSchema(runtime);

    const agentId = String(runtime.agentId);
    const nowIso = scenarioNow(ctx).toISOString();
    const dueAtIso = resolveScenarioIsoDate(args.dueAt, ctx);
    const definitionId = `seed-def-${args.id}`;

    await executeRawSql(
      runtime,
      `INSERT INTO life_task_definitions (
         id, agent_id, subject_id, kind, title, created_at, updated_at
       ) VALUES (
         ${sqlQuote(definitionId)},
         ${sqlQuote(agentId)},
         ${sqlQuote(agentId)},
         ${sqlQuote(args.kind ?? "task")},
         ${sqlQuote(args.title)},
         ${sqlQuote(nowIso)},
         ${sqlQuote(nowIso)}
       )`,
    );

    await executeRawSql(
      runtime,
      `INSERT INTO life_task_occurrences (
         id, agent_id, subject_id, definition_id, occurrence_key, due_at,
         relevance_start_at, relevance_end_at, state, created_at, updated_at
       ) VALUES (
         ${sqlQuote(args.id)},
         ${sqlQuote(agentId)},
         ${sqlQuote(agentId)},
         ${sqlQuote(definitionId)},
         ${sqlQuote(`seed:${args.id}`)},
         ${sqlQuote(dueAtIso)},
         ${sqlQuote(dueAtIso)},
         ${sqlQuote(new Date(Date.parse(dueAtIso) + 6 * 60 * 60_000).toISOString())},
         ${sqlQuote(args.state ?? "pending")},
         ${sqlQuote(nowIso)},
         ${sqlQuote(nowIso)}
       )`,
    );

    return undefined;
  };
}

export function seedCheckinTodo(args: {
  id: string;
  title: string;
  dueAt: string;
  state?: "pending" | "active" | "in_progress" | "completed";
}) {
  return seedCheckinDefinition({
    ...args,
    kind: "task",
  });
}
