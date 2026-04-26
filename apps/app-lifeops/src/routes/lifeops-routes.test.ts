import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../lifeops/service.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

const runtime = {
  agentId: "00000000-0000-0000-0000-000000000000",
} as LifeOpsRouteContext["state"]["runtime"];

function createContext(
  method: string,
  path: string,
  overrides: Partial<LifeOpsRouteContext> = {},
): {
  context: LifeOpsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
} {
  const url = new URL(path, "http://localhost");
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn(async () => ({}));
  const context: LifeOpsRouteContext = {
    req: {
      url: `${url.pathname}${url.search}`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res: {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: null,
    },
    json,
    error,
    readJsonBody,
    decodePathComponent: (raw) => decodeURIComponent(raw),
    ...overrides,
  };

  return {
    context,
    error,
    json,
    readJsonBody: context.readJsonBody as ReturnType<typeof vi.fn>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LifeOps route auth + rate limits", () => {
  it("returns 503 when the agent runtime is not available (state-changing)", async () => {
    const readJsonBody = vi.fn(async () => ({
      to: "+15551112222",
      text: "hi",
    }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/imessage/send",
      {
        readJsonBody,
        state: { runtime: null, adminEntityId: null },
      },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      context.res,
      "Agent runtime is not available",
      503,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("returns 503 when the agent runtime is not available (read)", async () => {
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/app-state",
      { state: { runtime: null, adminEntityId: null } },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      context.res,
      "Agent runtime is not available",
      503,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    {
      path: "/api/lifeops/smart-features/settings",
      maxAllowed: 60,
      body: { emailClassifierEnabled: true },
      mockService: null,
      runtimePatch: {
        setSetting: vi.fn(),
      },
    },
    {
      path: "/api/lifeops/money/bills/mark-paid",
      maxAllowed: 30,
      body: { billId: "bill-1" },
      mockService: "markBillPaid" as const,
      runtimePatch: {},
    },
    {
      path: "/api/lifeops/money/bills/snooze",
      maxAllowed: 30,
      body: { billId: "bill-1", days: 7 },
      mockService: "snoozeBill" as const,
      runtimePatch: {},
    },
  ])("rate-limits new write route $path", async (scenario) => {
    const agentId = `00000000-0000-0000-0000-${String(Math.trunc(Math.random() * 1_000_000)).padStart(12, "0")}`;
    const routeRuntime = {
      ...runtime,
      agentId,
      ...scenario.runtimePatch,
    } as LifeOpsRouteContext["state"]["runtime"];
    const readJsonBody = vi.fn(async () => scenario.body);
    if (scenario.mockService) {
      vi.spyOn(
        LifeOpsService.prototype,
        scenario.mockService,
      ).mockResolvedValue(
        scenario.mockService === "snoozeBill"
          ? { ok: true, dueDate: "2026-05-01" }
          : { ok: true },
      );
    }
    const { context } = createContext("POST", scenario.path, {
      readJsonBody,
      state: { runtime: routeRuntime, adminEntityId: null },
    });

    for (let i = 0; i < scenario.maxAllowed; i += 1) {
      await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    }

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(context.res.writeHead).toHaveBeenCalledWith(429, {
      "Retry-After": expect.any(String),
    });
    expect(context.res.end).toHaveBeenCalledWith(
      expect.stringContaining("Rate limit exceeded"),
    );
  });
});

describe("LifeOps route validation", () => {
  it("rejects malformed positive integer query values", async () => {
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/x/dms/digest?limit=10abc",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "limit must be a positive integer",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects mismatched connector side values before dispatch", async () => {
    const readJsonBody = vi.fn(async () => ({ side: "agent" }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/signal/pair?side=owner",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "side must match between query string and request body",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("returns a 400 for missing Signal pairing session id", async () => {
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/connectors/signal/pairing-status",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "sessionId is required",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects non-string iMessage recipients at the route boundary", async () => {
    const readJsonBody = vi.fn(async () => ({ to: 1, text: "hi" }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/imessage/send",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(context.res, "to is required", 400);
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects non-string iMessage attachment paths", async () => {
    const readJsonBody = vi.fn(async () => ({
      to: "+15551112222",
      text: "hi",
      attachmentPaths: ["/tmp/a.txt", 1],
    }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/connectors/imessage/send",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "attachmentPaths must be an array of strings",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects string booleans for X DM curation", async () => {
    const readJsonBody = vi.fn(async () => ({
      messageIds: ["dm-1"],
      markRead: "false",
    }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/x/dms/curate",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "markRead must be a boolean",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects scalar messageIds for X DM curation", async () => {
    const readJsonBody = vi.fn(async () => ({ messageIds: "abc" }));
    const { context, error, json } = createContext(
      "POST",
      "/api/lifeops/x/dms/curate",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "messageIds must be an array of strings",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects X DM digest limits above the route maximum before service dispatch", async () => {
    const getXDmDigest = vi.spyOn(LifeOpsService.prototype, "getXDmDigest");
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/x/dms/digest?limit=101",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "limit must be less than or equal to 100",
      400,
    );
    expect(json).not.toHaveBeenCalled();
    expect(getXDmDigest).not.toHaveBeenCalled();
  });

  it("passes inbox cache controls through to the service", async () => {
    const getInbox = vi.spyOn(LifeOpsService.prototype, "getInbox").mockResolvedValue({
      messages: [],
      channelCounts: {
        gmail: { total: 0, unread: 0 },
        discord: { total: 0, unread: 0 },
        telegram: { total: 0, unread: 0 },
        signal: { total: 0, unread: 0 },
        imessage: { total: 0, unread: 0 },
        whatsapp: { total: 0, unread: 0 },
        sms: { total: 0, unread: 0 },
        x_dm: { total: 0, unread: 0 },
      },
      fetchedAt: "2026-04-22T12:00:00.000Z",
    });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/inbox?channels=gmail,telegram&limit=25&cacheMode=refresh&cacheLimit=1200&groupByThread=true",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getInbox).toHaveBeenCalledWith({
      limit: 25,
      channels: ["gmail", "telegram"],
      groupByThread: true,
      chatTypeFilter: undefined,
      maxParticipants: undefined,
      gmailAccountId: undefined,
      missedOnly: undefined,
      sortByPriority: undefined,
      cacheMode: "refresh",
      cacheLimit: 1200,
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({ messages: [] }),
    );
  });

  it("rejects invalid inbox cache modes before service dispatch", async () => {
    const getInbox = vi.spyOn(LifeOpsService.prototype, "getInbox");
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/inbox?cacheMode=forever",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "cacheMode must be one of: read-through, refresh, cache-only",
      400,
    );
    expect(json).not.toHaveBeenCalled();
    expect(getInbox).not.toHaveBeenCalled();
  });

  it("passes Gmail recommendation query inputs through to the service", async () => {
    const getGmailRecommendations = vi
      .spyOn(LifeOpsService.prototype, "getGmailRecommendations")
      .mockResolvedValue({
        recommendations: [],
        source: "synced",
        syncedAt: "2026-04-22T12:00:00.000Z",
        summary: {
          totalCount: 0,
          replyCount: 0,
          archiveCount: 0,
          markReadCount: 0,
          spamReviewCount: 0,
          destructiveCount: 0,
        },
      });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/gmail/recommendations?side=owner&mode=local&grantId=grant-1&query=in%3Aspam&forceSync=true&includeSpamTrash=true&replyNeededOnly=false&maxResults=7",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getGmailRecommendations).toHaveBeenCalledWith(expect.any(URL), {
      mode: "local",
      side: "owner",
      forceSync: true,
      maxResults: 7,
      query: "in:spam",
      replyNeededOnly: false,
      includeSpamTrash: true,
      grantId: "grant-1",
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        recommendations: [],
      }),
    );
  });

  it("passes Gmail spam review query inputs through to the service", async () => {
    const getGmailSpamReviewItems = vi
      .spyOn(LifeOpsService.prototype, "getGmailSpamReviewItems")
      .mockResolvedValue({
        items: [],
        summary: {
          totalCount: 0,
          pendingCount: 0,
          confirmedSpamCount: 0,
          notSpamCount: 0,
          dismissedCount: 0,
        },
      });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/gmail/spam-review?side=owner&mode=local&grantId=grant-1&status=pending&maxResults=9",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getGmailSpamReviewItems).toHaveBeenCalledWith(expect.any(URL), {
      mode: "local",
      side: "owner",
      grantId: "grant-1",
      status: "pending",
      maxResults: 9,
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        items: [],
      }),
    );
  });

  it("routes Gmail spam review status updates to the service", async () => {
    const updateGmailSpamReviewItem = vi
      .spyOn(LifeOpsService.prototype, "updateGmailSpamReviewItem")
      .mockResolvedValue({
        item: {
          id: "review-1",
          agentId: "agent-1",
          provider: "google",
          side: "owner",
          grantId: "grant-1",
          accountEmail: "owner@example.test",
          messageId: "life-gmail-1",
          externalMessageId: "gmail-ext-1",
          threadId: "thread-1",
          subject: "Spam",
          from: "Sender",
          fromEmail: "sender@example.test",
          receivedAt: "2026-04-22T12:00:00.000Z",
          snippet: "spam",
          labels: ["SPAM"],
          rationale: "review",
          confidence: 0.92,
          status: "confirmed_spam",
          createdAt: "2026-04-22T12:00:00.000Z",
          updatedAt: "2026-04-22T12:01:00.000Z",
          reviewedAt: "2026-04-22T12:01:00.000Z",
        },
      });
    const body = { status: "confirmed_spam" as const };
    const readJsonBody = vi.fn(async () => body);
    const { context, error, json } = createContext(
      "PATCH",
      "/api/lifeops/gmail/spam-review/review-1",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(updateGmailSpamReviewItem).toHaveBeenCalledWith(
      expect.any(URL),
      "review-1",
      { status: "confirmed_spam" },
    );
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        item: expect.objectContaining({ status: "confirmed_spam" }),
      }),
    );
  });

  it("passes calendar update provider context through to the service", async () => {
    const updateCalendarEvent = vi
      .spyOn(LifeOpsService.prototype, "updateCalendarEvent")
      .mockResolvedValue({
        id: "life-event-1",
        externalId: "google-event-1",
        agentId: "agent-1",
        provider: "google",
        side: "owner",
        calendarId: "primary",
        title: "Dentist",
        description: "",
        location: "",
        status: "confirmed",
        startAt: "2026-04-23T15:00:00.000Z",
        endAt: "2026-04-23T16:00:00.000Z",
        isAllDay: false,
        timezone: "America/Los_Angeles",
        htmlLink: null,
        conferenceLink: null,
        organizer: null,
        attendees: [],
        metadata: {},
        syncedAt: "2026-04-23T14:00:00.000Z",
        updatedAt: "2026-04-23T14:00:00.000Z",
      });
    const readJsonBody = vi.fn(async () => ({
      side: "owner",
      grantId: "grant-1",
      calendarId: "primary",
      title: "Dentist",
      timeZone: "America/Los_Angeles",
    }));
    const { context, error, json } = createContext(
      "PATCH",
      "/api/lifeops/calendar/events/google-event-1",
      { readJsonBody },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(updateCalendarEvent).toHaveBeenCalledWith(expect.any(URL), {
      eventId: "google-event-1",
      side: "owner",
      grantId: "grant-1",
      calendarId: "primary",
      title: "Dentist",
      description: undefined,
      startAt: undefined,
      endAt: undefined,
      timeZone: "America/Los_Angeles",
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        event: expect.objectContaining({ externalId: "google-event-1" }),
      }),
    );
  });

  it("passes calendar delete provider context through to the service", async () => {
    const deleteCalendarEvent = vi
      .spyOn(LifeOpsService.prototype, "deleteCalendarEvent")
      .mockResolvedValue(undefined);
    const { context, error, json } = createContext(
      "DELETE",
      "/api/lifeops/calendar/events/google-event-1?side=owner&grantId=grant-1&calendarId=primary",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(deleteCalendarEvent).toHaveBeenCalledWith(expect.any(URL), {
      eventId: "google-event-1",
      side: "owner",
      grantId: "grant-1",
      calendarId: "primary",
    });
    expect(json).toHaveBeenCalledWith(context.res, { deleted: true });
  });

  it("passes screen-time summary query inputs through to the service", async () => {
    const getScreenTimeSummary = vi
      .spyOn(LifeOpsService.prototype, "getScreenTimeSummary")
      .mockResolvedValue({
        items: [
          {
            source: "app",
            identifier: "com.example.Editor",
            displayName: "Editor",
            totalSeconds: 3600,
          },
        ],
        totalSeconds: 3600,
      });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/screen-time/summary?since=2026-04-22T00%3A00%3A00.000Z&until=2026-04-22T12%3A00%3A00.000Z&source=app&topN=4",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getScreenTimeSummary).toHaveBeenCalledWith({
      since: "2026-04-22T00:00:00.000Z",
      until: "2026-04-22T12:00:00.000Z",
      source: "app",
      topN: 4,
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        totalSeconds: 3600,
      }),
    );
  });

  it("passes screen-time breakdown query inputs through to the service", async () => {
    const getScreenTimeBreakdown = vi
      .spyOn(LifeOpsService.prototype, "getScreenTimeBreakdown")
      .mockResolvedValue({
        items: [],
        totalSeconds: 0,
        bySource: [],
        byCategory: [],
        byDevice: [],
        byService: [],
        byBrowser: [],
        fetchedAt: "2026-04-22T12:00:00.000Z",
      });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/screen-time/breakdown?since=2026-04-22T00%3A00%3A00.000Z&until=2026-04-22T12%3A00%3A00.000Z&source=website&topN=8",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getScreenTimeBreakdown).toHaveBeenCalledWith({
      since: "2026-04-22T00:00:00.000Z",
      until: "2026-04-22T12:00:00.000Z",
      source: "website",
      topN: 8,
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        fetchedAt: "2026-04-22T12:00:00.000Z",
      }),
    );
  });

  it("passes social summary query inputs through to the service", async () => {
    const getSocialHabitSummary = vi
      .spyOn(LifeOpsService.prototype, "getSocialHabitSummary")
      .mockResolvedValue({
        since: "2026-04-22T00:00:00.000Z",
        until: "2026-04-22T12:00:00.000Z",
        totalSeconds: 0,
        services: [],
        devices: [],
        surfaces: [],
        browsers: [],
        sessions: [],
        messages: {
          channels: [],
          inbound: 0,
          outbound: 0,
          opened: 0,
          replied: 0,
        },
        dataSources: [],
        fetchedAt: "2026-04-22T12:00:00.000Z",
      });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/social/summary?since=2026-04-22T00%3A00%3A00.000Z&until=2026-04-22T12%3A00%3A00.000Z&topN=6",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getSocialHabitSummary).toHaveBeenCalledWith({
      since: "2026-04-22T00:00:00.000Z",
      until: "2026-04-22T12:00:00.000Z",
      topN: 6,
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        fetchedAt: "2026-04-22T12:00:00.000Z",
      }),
    );
  });

  // Browser companion + package routes moved to
  // `@elizaos/plugin-browser-bridge` (Phase 3). Tests for those routes now
  // live alongside the plugin package.
});
