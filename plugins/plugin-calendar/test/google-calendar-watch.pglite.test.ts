/**
 * Google Calendar push lifecycle tests use real PGlite persistence, the real
 * ScheduledTask runner, and a loopback HTTP server around the public route.
 * Only Google's remote API is represented by a deterministic transport.
 */
import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { ConnectorAccountManager, IAgentRuntime } from "@elizaos/core";
import {
  createGoogleConnectorAccountProvider,
  GoogleCalendarSyncTokenExpiredError,
} from "@elizaos/plugin-google-workspace";
import {
  getScheduledTaskRunner,
  ScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CALENDAR_WEBHOOK_PATH,
  type GoogleCalendarNotificationHeaders,
} from "../src/google-watch/index.js";
import { calendarRouteHandler } from "../src/routes/plugin-routes.js";
import {
  type CalendarHostGate,
  CalendarService,
  ensureCalendarFeedPreferenceTable,
  ensureGoogleCalendarWatchChannelTable,
  ensureIcsCalendarSourceTable,
  ensureIcsSecretCleanupTable,
} from "../src/service/index.js";

const AGENT_ID = "google-watch-pglite-agent";
const ACCOUNT_ID = "account-a";
const GRANT_ID = `connector-account:${ACCOUNT_ID}`;
const RESOURCE_URI =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TIME_MIN = "2026-07-27T00:00:00.000Z";
const TIME_MAX = "2026-07-28T00:00:00.000Z";
const PUBLIC_WEBHOOK_URL = `https://calendar.example.com${GOOGLE_CALENDAR_WEBHOOK_PATH}`;

const CREATE_EVENTS_TABLE = `CREATE TABLE app_calendar.life_calendar_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  connector_account_id TEXT,
  purge_resync_required BOOLEAN NOT NULL DEFAULT false,
  purge_resync_reason TEXT,
  grant_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_all_day BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT,
  html_link TEXT,
  conference_link TEXT,
  organizer_json TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT calendar_events_source_external_unique
    UNIQUE (agent_id, provider, side, grant_id, calendar_id, external_event_id)
)`;

const CREATE_SYNC_TABLE = `CREATE TABLE app_calendar.life_calendar_sync_states (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  calendar_id TEXT NOT NULL,
  connector_account_id TEXT,
  grant_id TEXT,
  purge_resync_required BOOLEAN NOT NULL DEFAULT false,
  purge_resync_reason TEXT,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  next_sync_token TEXT,
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT calendar_sync_states_source_unique
    UNIQUE (agent_id, provider, side, grant_id, calendar_id)
)`;

function grant(accountId = ACCOUNT_ID): LifeOpsConnectorGrant {
  const timestamp = "2026-07-26T00:00:00.000Z";
  return {
    id: `connector-account:${accountId}`,
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: accountId,
    side: "owner",
    identity: { email: `${accountId}@example.test` },
    identityEmail: `${accountId}@example.test`,
    grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    capabilities: ["google.calendar.read"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function status(
  sourceGrant: LifeOpsConnectorGrant,
): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: true,
    connected: true,
    reason: "connected",
    preferredByAgent: true,
    cloudConnectionId: null,
    identity: sourceGrant.identity,
    grantedCapabilities: ["google.calendar.read"],
    grantedScopes: [...sourceGrant.grantedScopes],
    expiresAt: null,
    hasRefreshToken: true,
    grant: sourceGrant,
  };
}

interface WatchRequest {
  accountId: string;
  calendarId: string;
  channelId: string;
  address: string;
  token: string;
  ttlSeconds: number;
}

interface EventPageRequest {
  accountId: string;
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
}

class FakeGoogleCalendar {
  readonly watchRequests: WatchRequest[] = [];
  readonly eventPageRequests: EventPageRequest[] = [];
  readonly stopRequests: Array<{
    accountId: string;
    channelId: string;
    resourceId: string;
  }> = [];
  loopbackBaseUrl: string | null = null;
  sendSyncBeforeWatchResponse = true;
  expirationMsFromNow = 7 * 24 * 60 * 60 * 1000;
  failNextIncrementalWith503 = false;
  failNextIncrementalWith403Quota = false;
  expireNextIncrementalCursor = false;
  private syncGeneration = 0;

  async listCalendars() {
    return [
      {
        calendarId: "primary",
        summary: "Primary",
        description: null,
        primary: true,
        accessRole: "owner",
        backgroundColor: null,
        foregroundColor: null,
        timeZone: "UTC",
        selected: true,
      },
    ];
  }

  async listEventPage(request: EventPageRequest) {
    this.eventPageRequests.push({ ...request });
    if (request.syncToken && this.failNextIncrementalWith503) {
      this.failNextIncrementalWith503 = false;
      throw {
        response: {
          status: 503,
          headers: { "retry-after": "1" },
        },
      };
    }
    if (request.syncToken && this.failNextIncrementalWith403Quota) {
      this.failNextIncrementalWith403Quota = false;
      throw {
        response: {
          status: 403,
          data: {
            error: {
              errors: [{ reason: "userRateLimitExceeded" }],
            },
          },
        },
      };
    }
    if (request.syncToken && this.expireNextIncrementalCursor) {
      this.expireNextIncrementalCursor = false;
      throw new GoogleCalendarSyncTokenExpiredError({
        resource: "events",
        accountId: request.accountId,
        calendarId: "primary",
        cause: { response: { status: 410 } },
      });
    }
    this.syncGeneration += 1;
    return {
      events: request.syncToken
        ? []
        : [
            {
              id: "event-1",
              calendarId: "primary",
              title: "School pickup",
              status: "confirmed",
              start: "2026-07-27T16:00:00.000Z",
              end: "2026-07-27T17:00:00.000Z",
              isAllDay: false,
              timeZone: "UTC",
              attendees: [],
              metadata: {},
            },
          ],
      nextPageToken: null,
      nextSyncToken: `sync-${this.syncGeneration}`,
    };
  }

  async watchEvents(request: WatchRequest) {
    this.watchRequests.push({ ...request });
    const resourceId = `resource-${this.watchRequests.length}`;
    if (this.sendSyncBeforeWatchResponse) {
      if (!this.loopbackBaseUrl) {
        throw new Error(
          "Loopback route must be running before watch creation.",
        );
      }
      const response = await postNotification(this.loopbackBaseUrl, {
        channelId: request.channelId,
        channelToken: request.token,
        resourceId,
        resourceUri: RESOURCE_URI,
        resourceState: "sync",
        messageNumber: "1",
      });
      if (response.status !== 204) {
        throw new Error(`Early sync notification returned ${response.status}.`);
      }
    }
    return {
      channelId: request.channelId,
      resourceId,
      resourceUri: RESOURCE_URI,
      token: request.token,
      expirationAt: new Date(
        Date.now() + this.expirationMsFromNow,
      ).toISOString(),
    };
  }

  async stopCalendarChannel(request: {
    accountId: string;
    channelId: string;
    resourceId: string;
  }): Promise<void> {
    this.stopRequests.push({ ...request });
  }
}

interface Harness {
  pg: PGlite;
  runtime: IAgentRuntime;
  calendar: CalendarService;
  scheduling: ScheduledTaskRunnerService;
  google: FakeGoogleCalendar;
  server: Server;
  baseUrl: string;
  reportError: ReturnType<typeof vi.fn>;
  setBindingAccount(accountId: string): void;
  close(options?: { closeDatabase?: boolean }): Promise<void>;
}

async function initializeDatabase(pg: PGlite): Promise<void> {
  await pg.query("CREATE SCHEMA IF NOT EXISTS app_calendar");
  await pg.query(CREATE_EVENTS_TABLE);
  await pg.query(CREATE_SYNC_TABLE);
  const execute = async (statement: string) => {
    const result = await pg.query<Record<string, unknown>>(statement);
    return result.rows;
  };
  await ensureIcsCalendarSourceTable(execute);
  await ensureIcsSecretCleanupTable(execute);
  await ensureCalendarFeedPreferenceTable(execute);
  await ensureGoogleCalendarWatchChannelTable(execute);
}

async function listen(
  runtime: IAgentRuntime,
): Promise<{ server: Server; baseUrl: string }> {
  const handler = calendarRouteHandler();
  const server = createServer((req, res) => {
    void handler(req, res, runtime).catch((error: unknown) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback server did not expose a TCP address.");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createHarness(
  args: {
    pg?: PGlite;
    google?: FakeGoogleCalendar;
    initialize?: boolean;
    webhookEnabled?: boolean;
    calendarBeforeScheduling?: boolean;
  } = {},
): Promise<Harness> {
  const pg = args.pg ?? new PGlite();
  if (args.initialize !== false) {
    await initializeDatabase(pg);
  }
  const db = drizzle(pg);
  const google = args.google ?? new FakeGoogleCalendar();
  const reportError = vi.fn();
  let calendar: CalendarService | null = null;
  let scheduling: ScheduledTaskRunnerService | null = null;
  let bindingAccountId = ACCOUNT_ID;
  const runtime = {
    agentId: AGENT_ID,
    adapter: {
      db,
      listConnectorAccountCredentialRefs: async () => [],
      deleteConnectorAccountCredentialRefs: async () => 0,
    },
    db,
    initPromise: Promise.resolve(),
    getSetting: (key: string) => {
      const values: Record<string, string> = {
        GOOGLE_CALENDAR_WEBHOOK_ENABLED: String(args.webhookEnabled ?? true),
        GOOGLE_CALENDAR_WEBHOOK_URL: PUBLIC_WEBHOOK_URL,
        GOOGLE_CALENDAR_WATCH_TTL_SECONDS: "3600",
        GOOGLE_CALENDAR_WATCH_RENEWAL_LEAD_MINUTES: "1440",
        GOOGLE_CALENDAR_WATCH_SYNC_LEASE_SECONDS: "300",
        GOOGLE_CALENDAR_MAX_WATCHES_PER_ACCOUNT: "8",
        GOOGLE_CALENDAR_MAX_CONCURRENT_PUSH_SYNCS_PER_ACCOUNT: "2",
      };
      return values[key] ?? null;
    },
    getService: (name: string) => {
      if (name === "calendar") return calendar;
      if (name === "google") return google;
      if (name === ScheduledTaskRunnerService.serviceType) return scheduling;
      return null;
    },
    hasService: (name: string) =>
      name === ScheduledTaskRunnerService.serviceType && scheduling !== null,
    getServiceRegistrationStatus: (name: string) =>
      name === ScheduledTaskRunnerService.serviceType && scheduling !== null
        ? "registered"
        : "unknown",
    getServiceLoadPromise: async (name: string) => {
      if (name === "calendar") return calendar;
      if (name === ScheduledTaskRunnerService.serviceType) return scheduling;
      return null;
    },
    reportError,
    getCache: async () => undefined,
    setCache: async () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;

  if (args.calendarBeforeScheduling) {
    calendar = await CalendarService.start(runtime);
    // Let the detached boot installer observe the missing deferred declaration
    // before the real runner is made available.
    await Promise.resolve();
    await Promise.resolve();
    scheduling = await ScheduledTaskRunnerService.start(runtime);
  } else {
    scheduling = await ScheduledTaskRunnerService.start(runtime);
    calendar = await CalendarService.start(runtime);
  }
  const gate: CalendarHostGate = {
    getGoogleConnectorAccounts: async () => [status(grant(ACCOUNT_ID))],
    resolveGuestAvailabilityGrants: async () => {
      throw new Error("Guest availability is outside this test.");
    },
    requireGoogleCalendarGrant: async () => grant(bindingAccountId),
    requireGoogleCalendarWriteGrant: async () => grant(ACCOUNT_ID),
    createReminderPlan: async () => undefined,
    updateReminderPlan: async () => undefined,
    deleteReminderPlan: async () => undefined,
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => undefined,
  };
  calendar.setGate(gate);
  const route = await listen(runtime);
  google.loopbackBaseUrl = route.baseUrl;

  return {
    pg,
    runtime,
    calendar,
    scheduling,
    google,
    server: route.server,
    baseUrl: route.baseUrl,
    reportError,
    setBindingAccount(accountId) {
      bindingAccountId = accountId;
    },
    async close(options = {}) {
      await closeServer(route.server);
      await scheduling?.stop();
      if (options.closeDatabase !== false) {
        await pg.close();
      }
    },
  };
}

async function postNotification(
  baseUrl: string,
  headers: GoogleCalendarNotificationHeaders,
  body?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${GOOGLE_CALENDAR_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "X-Goog-Channel-ID": headers.channelId,
      "X-Goog-Channel-Token": headers.channelToken,
      "X-Goog-Resource-ID": headers.resourceId,
      "X-Goog-Resource-URI": headers.resourceUri,
      "X-Goog-Resource-State": headers.resourceState,
      "X-Goog-Message-Number": headers.messageNumber,
    },
    ...(body === undefined ? {} : { body }),
  });
}

async function forceInitialSync(harness: Harness) {
  return harness.calendar.getCalendarFeed(
    new URL(`${harness.baseUrl}/api/lifeops/calendar/feed`),
    {
      grantId: GRANT_ID,
      calendarId: "primary",
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
      timeZone: "UTC",
      forceSync: true,
    },
    new Date("2026-07-26T12:00:00.000Z"),
  );
}

async function watchRows(pg: PGlite) {
  return (
    await pg.query<Record<string, unknown>>(
      `SELECT * FROM app_calendar.google_calendar_watch_channels
       ORDER BY created_at ASC`,
    )
  ).rows;
}

async function waitForMaintenanceTask(harness: Harness): Promise<string> {
  const runner = getScheduledTaskRunner(harness.runtime, {
    agentId: AGENT_ID,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tasks = await runner.list({ kind: "watcher" });
    const maintenance = tasks.find(
      (task) => task.metadata?.calendarGoogleWatchOperation === "maintenance",
    );
    if (maintenance) return maintenance.taskId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Maintenance task was not installed.");
}

async function waitForSyncRetryTask(
  harness: Harness,
  channelId: string,
): Promise<string> {
  const runner = getScheduledTaskRunner(harness.runtime, {
    agentId: AGENT_ID,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tasks = await runner.list({ kind: "custom" });
    const retry = tasks.find(
      (task) =>
        task.metadata?.calendarGoogleWatchOperation === "sync-retry" &&
        task.metadata?.channelId === channelId &&
        task.state.status === "scheduled",
    );
    if (retry) return retry.taskId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Google Calendar notification retry task was not scheduled.");
}

describe("Google Calendar push lifecycle", { timeout: 30_000 }, () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (harness) await harness.close();
    }
  });

  it("installs one maintenance task when Calendar starts before the deferred runner", async () => {
    const harness = await createHarness({ calendarBeforeScheduling: true });
    harnesses.push(harness);

    const maintenanceTaskId = await waitForMaintenanceTask(harness);
    const tasks = await getScheduledTaskRunner(harness.runtime, {
      agentId: AGENT_ID,
    }).list({ kind: "watcher" });
    const maintenanceTasks = tasks.filter(
      (task) => task.metadata?.calendarGoogleWatchOperation === "maintenance",
    );

    expect(maintenanceTasks.map((task) => task.taskId)).toEqual([
      maintenanceTaskId,
    ]);
    expect(harness.reportError).not.toHaveBeenCalledWith(
      "calendar:google-watch-install",
      expect.anything(),
    );
  });

  it("does not create or accept push channels when the webhook is disabled", async () => {
    const harness = await createHarness({ webhookEnabled: false });
    harnesses.push(harness);

    const feed = await forceInitialSync(harness);
    const maintenanceTaskId = await waitForMaintenanceTask(harness);
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: AGENT_ID,
    });
    const maintenance = await runner.fireWithResult(maintenanceTaskId);
    const response = await postNotification(harness.baseUrl, {
      channelId: "disabled-channel",
      channelToken: "disabled-token",
      resourceId: "disabled-resource",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });

    expect(harness.google.watchRequests).toEqual([]);
    expect(await watchRows(harness.pg)).toEqual([]);
    expect(feed.sources[0]?.changeDelivery).toMatchObject({
      mode: "polling",
      status: "unconfigured",
    });
    expect(maintenance.kind).toBe("fired");
    expect(response.status).toBe(404);
  });

  it("binds and processes the sync notification that arrives before the watch response", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const feed = await forceInitialSync(harness);
    const request = harness.google.watchRequests[0];
    const rows = await watchRows(harness.pg);

    expect(request).toBeDefined();
    expect(harness.google.eventPageRequests).toHaveLength(2);
    expect(harness.google.eventPageRequests[0]?.syncToken).toBeUndefined();
    expect(harness.google.eventPageRequests[1]?.syncToken).toBe("sync-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel_id: request?.channelId,
      connector_account_id: ACCOUNT_ID,
      grant_id: GRANT_ID,
      calendar_id: "primary",
      resource_id: "resource-1",
      resource_uri: RESOURCE_URI,
      state: "active",
      last_message_number: "1",
      pending_message_number: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain(request?.token);
    expect(feed.sources[0]?.changeDelivery).toMatchObject({
      mode: "push",
      status: "active",
      lastNotificationAt: expect.any(String),
      lastSuccessfulSyncAt: expect.any(String),
    });

    const beforeBodyAttempt = harness.google.eventPageRequests.length;
    const bodyResponse = await postNotification(
      harness.baseUrl,
      {
        channelId: request?.channelId ?? "",
        channelToken: request?.token ?? "",
        resourceId: "resource-1",
        resourceUri: RESOURCE_URI,
        resourceState: "exists",
        messageNumber: "2",
      },
      "{}",
    );
    expect(bodyResponse.status).toBe(400);
    expect(harness.google.eventPageRequests).toHaveLength(beforeBodyAttempt);
  }, 30_000);

  it("survives a runtime restart and ignores duplicate or out-of-order message numbers", async () => {
    const first = await createHarness();
    await forceInitialSync(first);
    const request = first.google.watchRequests[0];
    expect(request).toBeDefined();
    await first.close({ closeDatabase: false });

    const restarted = await createHarness({
      pg: first.pg,
      google: first.google,
      initialize: false,
    });
    harnesses.push(restarted);
    const before = restarted.google.eventPageRequests.length;

    const accepted = await postNotification(restarted.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "10",
    });
    const duplicate = await postNotification(restarted.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "10",
    });
    const outOfOrder = await postNotification(restarted.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "7",
    });
    const nonSequential = await postNotification(restarted.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "not_exists",
      messageNumber: "13",
    });

    expect([
      accepted.status,
      duplicate.status,
      outOfOrder.status,
      nonSequential.status,
    ]).toEqual([204, 204, 204, 204]);
    expect(restarted.google.eventPageRequests).toHaveLength(before + 2);
    const rows = await watchRows(restarted.pg);
    expect(rows[0]?.last_message_number).toBe("13");
    expect(rows[0]?.pending_message_number).toBeNull();
  });

  it("does not mutate durable channel state for an invalid capability token", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await forceInitialSync(harness);
    const request = harness.google.watchRequests[0];
    expect(request).toBeDefined();
    const beforeRows = await watchRows(harness.pg);
    const beforeProviderCalls = harness.google.eventPageRequests.length;

    const response = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: "invalid-capability",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });

    expect(response.status).toBe(404);
    expect(await watchRows(harness.pg)).toEqual(beforeRows);
    expect(harness.google.eventPageRequests).toHaveLength(beforeProviderCalls);
  });

  it("rejects stale tokens, wrong resources, and changed account bindings", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await forceInitialSync(harness);
    const request = harness.google.watchRequests[0];
    expect(request).toBeDefined();
    const before = harness.google.eventPageRequests.length;

    const staleToken = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: "stale-token",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });
    const wrongResource = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "wrong-resource",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });
    harness.setBindingAccount("wrong-account");
    const wrongAccount = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });

    expect([
      staleToken.status,
      wrongResource.status,
      wrongAccount.status,
    ]).toEqual([404, 404, 404]);
    expect(harness.google.eventPageRequests).toHaveLength(before);
    const rows = await watchRows(harness.pg);
    expect(rows[0]?.state).toBe("revoked");
    expect(rows[0]?.last_message_number).toBe("1");
  });

  it("fails visibly instead of fabricating a cursor when durable channel state is malformed", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await forceInitialSync(harness);
    const request = harness.google.watchRequests[0];
    expect(request).toBeDefined();
    const before = harness.google.eventPageRequests.length;
    await harness.pg.query(
      `UPDATE app_calendar.google_calendar_watch_channels
          SET last_message_number = 'not-a-decimal'
        WHERE channel_id = $1`,
      [request?.channelId],
    );

    const response = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(harness.google.eventPageRequests).toHaveLength(before);
    expect(harness.reportError).toHaveBeenCalledWith(
      "CalendarRoutes.googleWebhook",
      expect.objectContaining({
        code: "GOOGLE_CALENDAR_WATCH_INVALID_STATE",
      }),
    );
  });

  it("returns 503 without advancing, recovers through ScheduledTask, and performs a controlled 410 full resync", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await forceInitialSync(harness);
    const request = harness.google.watchRequests[0];
    expect(request).toBeDefined();

    harness.google.failNextIncrementalWith503 = true;
    const failed = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "2",
    });
    let rows = await watchRows(harness.pg);
    expect(failed.status).toBe(503);
    expect(Number(failed.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(rows[0]?.last_message_number).toBe("1");
    expect(rows[0]?.pending_message_number).toBe("2");

    const retryTaskId = await waitForSyncRetryTask(
      harness,
      request?.channelId ?? "",
    );
    await harness.pg.query(
      `UPDATE app_calendar.google_calendar_watch_channels
          SET next_retry_at = '2000-01-01T00:00:00.000Z'
        WHERE channel_id = $1`,
      [request?.channelId],
    );
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: AGENT_ID,
    });
    const retried = await runner.fireWithResult(retryTaskId);
    rows = await watchRows(harness.pg);
    expect(retried.kind).toBe("fired");
    expect(rows[0]?.last_message_number).toBe("2");
    expect(rows[0]?.pending_message_number).toBeNull();

    harness.google.failNextIncrementalWith403Quota = true;
    const quotaLimited = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "3",
    });
    rows = await watchRows(harness.pg);
    expect(quotaLimited.status).toBe(503);
    expect(rows[0]).toMatchObject({
      state: "active",
      last_message_number: "2",
      pending_message_number: "3",
      last_error_code: "GOOGLE_CALENDAR_WATCH_RATE_LIMITED",
    });
    const quotaRetryTaskId = await waitForSyncRetryTask(
      harness,
      request?.channelId ?? "",
    );
    await harness.pg.query(
      `UPDATE app_calendar.google_calendar_watch_channels
          SET next_retry_at = '2000-01-01T00:00:00.000Z'
        WHERE channel_id = $1`,
      [request?.channelId],
    );
    expect((await runner.fireWithResult(quotaRetryTaskId)).kind).toBe("fired");
    expect((await watchRows(harness.pg))[0]?.last_message_number).toBe("3");

    harness.google.expireNextIncrementalCursor = true;
    const before410 = harness.google.eventPageRequests.length;
    const recovered = await postNotification(harness.baseUrl, {
      channelId: request?.channelId ?? "",
      channelToken: request?.token ?? "",
      resourceId: "resource-1",
      resourceUri: RESOURCE_URI,
      resourceState: "exists",
      messageNumber: "8",
    });
    const recoveryRequests = harness.google.eventPageRequests.slice(before410);
    expect(recovered.status).toBe(204);
    expect(recoveryRequests).toHaveLength(2);
    expect(recoveryRequests[0]?.syncToken).toBeDefined();
    expect(recoveryRequests[1]?.syncToken).toBeUndefined();
    expect(recoveryRequests[1]?.timeMin).toBe(TIME_MIN);
    expect((await watchRows(harness.pg))[0]?.last_message_number).toBe("8");
  });

  it("maintenance recreates a structural retry for a stranded pending notification", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await forceInitialSync(harness);
    const request = harness.google.watchRequests[0];
    expect(request).toBeDefined();
    const before = harness.google.eventPageRequests.length;
    await harness.pg.query(
      `UPDATE app_calendar.google_calendar_watch_channels
          SET pending_message_number = '21',
              next_retry_at = '2000-01-01T00:00:00.000Z',
              sync_lease_token = NULL,
              sync_lease_expires_at = NULL,
              failure_count = 4
        WHERE channel_id = $1`,
      [request?.channelId],
    );

    const maintenanceTaskId = await waitForMaintenanceTask(harness);
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: AGENT_ID,
    });
    const maintenanceResult = await runner.fireWithResult(maintenanceTaskId);
    const retryTaskId = await waitForSyncRetryTask(
      harness,
      request?.channelId ?? "",
    );

    expect(maintenanceResult.kind).toBe("fired");
    expect(harness.google.eventPageRequests).toHaveLength(before);
    const retryResult = await runner.fireWithResult(retryTaskId);
    expect(retryResult.kind).toBe("fired");
    expect(harness.google.eventPageRequests).toHaveLength(before + 1);
    expect((await watchRows(harness.pg))[0]).toMatchObject({
      last_message_number: "21",
      pending_message_number: null,
      failure_count: 0,
      next_retry_at: null,
    });
  });

  it("renews with overlap and stops the old channel through ScheduledTask dispatch", async () => {
    const google = new FakeGoogleCalendar();
    google.expirationMsFromNow = 10 * 60 * 1000;
    const harness = await createHarness({ google });
    harnesses.push(harness);
    await forceInitialSync(harness);
    const maintenanceTaskId = await waitForMaintenanceTask(harness);
    const runner = getScheduledTaskRunner(harness.runtime, {
      agentId: AGENT_ID,
    });

    const result = await runner.fireWithResult(maintenanceTaskId);
    const rows = await watchRows(harness.pg);

    expect(result.kind).toBe("fired");
    expect(google.watchRequests).toHaveLength(2);
    expect(google.stopRequests).toHaveLength(1);
    expect(rows.map((row) => row.state)).toEqual(["stopped", "active"]);
    expect(rows[0]?.renewal_channel_id).toBe(rows[1]?.channel_id);
    const stopTasks = await harness.pg.query<{ metadata_json: string }>(
      `SELECT metadata_json
         FROM app_scheduling.life_scheduled_tasks
        WHERE metadata_json::jsonb ->> 'calendarGoogleWatchOperation' = 'stop'`,
    );
    expect(stopTasks.rows).toHaveLength(1);
  });

  it("revokes live channels through the runner before connector-account deletion", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await forceInitialSync(harness);
    const provider = createGoogleConnectorAccountProvider(harness.runtime);
    if (!provider.deleteAccount) {
      throw new Error("Google connector provider has no delete hook.");
    }

    const manager = {
      listAccounts: async () => [],
      getAccount: async () => ({
        id: ACCOUNT_ID,
        provider: "google",
        externalId: "google-calendar-watch-owner",
        role: "OWNER",
        purpose: ["calendar"],
        accessGate: "open",
        status: "pending",
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    } as unknown as ConnectorAccountManager;
    await provider.deleteAccount(ACCOUNT_ID, manager);

    const rows = await watchRows(harness.pg);
    expect(rows[0]?.state).toBe("revoked");
    expect(harness.google.stopRequests).toHaveLength(1);
    const stopTask = await harness.pg.query<{
      status: string;
      metadata_json: string;
    }>(
      `SELECT state_json::jsonb ->> 'status' AS status, metadata_json
         FROM app_scheduling.life_scheduled_tasks
        WHERE metadata_json::jsonb ->> 'calendarGoogleWatchOperation' = 'stop'`,
    );
    expect(stopTask.rows).toHaveLength(1);
    expect(stopTask.rows[0]?.status).toBe("fired");
  });
});
