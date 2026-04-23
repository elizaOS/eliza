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
    res: {} as http.ServerResponse,
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

  // Browser companion + package routes moved to
  // `@elizaos/plugin-browser-bridge` (Phase 3). Tests for those routes now
  // live alongside the plugin package.
});
