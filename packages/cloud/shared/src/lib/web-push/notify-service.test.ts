/**
 * Agent-reply push bridge coverage for the no-op cases, live delivery path,
 * dead-subscription pruning, and explicit infrastructure-failure result.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WEB_PUSH_PRIVATE_KEY_ENV, WEB_PUSH_PUBLIC_KEY_ENV } from "./config";
import { notifyAgentReply } from "./notify-service";

const CONFIGURED_ENV = {
  [WEB_PUSH_PUBLIC_KEY_ENV]: "PUBKEY",
  [WEB_PUSH_PRIVATE_KEY_ENV]: "PRIVKEY",
};

// Inject a no-op logger so the suite doesn't depend on the shared cloud logger.
const testLogger = { info: vi.fn(), warn: vi.fn() };

function fakeRepo(rows: Array<{ endpoint: string; p256dh: string; auth: string }>) {
  return {
    listForUserAgent: vi.fn(async () => rows),
    pruneEndpoints: vi.fn(async (eps: string[]) => eps.length),
    upsert: vi.fn(),
    deleteByEndpoint: vi.fn(),
  } as never;
}

const ROW = { endpoint: "https://push/1", p256dh: "p", auth: "a" };

describe("notifyAgentReply", () => {
  beforeEach(() => {
    testLogger.info.mockClear();
    testLogger.warn.mockClear();
  });

  test("no push when VAPID is unconfigured", async () => {
    const result = await notifyAgentReply(
      { userId: "u", agentId: "a", replyText: "hi", title: "Sol" },
      { env: {}, logger: testLogger },
    );
    expect(result).toEqual({ pushed: false, reason: "unconfigured" });
  });

  test("no push when a foreground client is live", async () => {
    const repo = fakeRepo([ROW]);
    const sendBatch = vi.fn();
    const result = await notifyAgentReply(
      { userId: "u", agentId: "a", replyText: "hi", title: "Sol" },
      {
        env: CONFIGURED_ENV,
        logger: testLogger,
        isForegroundActive: async () => true,
        repository: repo,
        sendBatch: sendBatch as never,
      },
    );
    expect(result).toEqual({ pushed: false, reason: "foreground-active" });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  test("no push when there are no subscriptions", async () => {
    const repo = fakeRepo([]);
    const sendBatch = vi.fn();
    const result = await notifyAgentReply(
      { userId: "u", agentId: "a", replyText: "hi", title: "Sol" },
      {
        env: CONFIGURED_ENV,
        logger: testLogger,
        repository: repo,
        sendBatch: sendBatch as never,
      },
    );
    expect(result).toEqual({ pushed: false, reason: "no-subscriptions" });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  test("pushes when not foreground + prunes gone endpoints", async () => {
    const repo = fakeRepo([ROW, { ...ROW, endpoint: "https://push/2" }]);
    const sendBatch = vi.fn(async () => ({
      sent: 1,
      failed: 1,
      goneEndpoints: ["https://push/2"],
    }));

    const result = await notifyAgentReply(
      {
        userId: "u",
        agentId: "a",
        replyText: "the agent said hello",
        title: "Sol",
        conversationId: "conv-1",
        badgeCount: 4,
      },
      {
        env: CONFIGURED_ENV,
        logger: testLogger,
        isForegroundActive: async () => false,
        repository: repo,
        sendBatch: sendBatch as never,
      },
    );

    expect(result).toEqual({ pushed: true, sent: 1, failed: 1, pruned: 1 });
    expect(repo.pruneEndpoints).toHaveBeenCalledWith(["https://push/2"]);

    // Payload carries tag = conversationId, badge, agentId.
    const [, payload] = sendBatch.mock.calls[0];
    expect(payload.tag).toBe("conv-1");
    expect(payload.conversationId).toBe("conv-1");
    expect(payload.agentId).toBe("a");
    expect(payload.badgeCount).toBe(4);
    expect(payload.body).toBe("the agent said hello");
    expect(payload.title).toBe("Sol");
  });

  test("truncates a long reply body with an ellipsis", async () => {
    const repo = fakeRepo([ROW]);
    const long = "x".repeat(500);
    const sendBatch = vi.fn(async () => ({
      sent: 1,
      failed: 0,
      goneEndpoints: [],
    }));
    await notifyAgentReply(
      { userId: "u", agentId: "a", replyText: long, title: "Sol" },
      {
        env: CONFIGURED_ENV,
        logger: testLogger,
        repository: repo,
        sendBatch: sendBatch as never,
      },
    );
    const [, payload] = sendBatch.mock.calls[0];
    expect(payload.body.length).toBeLessThanOrEqual(180);
    expect(payload.body.endsWith("…")).toBe(true);
  });

  test("never throws — a repository error yields a non-fatal failure result", async () => {
    const repo = {
      listForUserAgent: vi.fn(async () => {
        throw new Error("db down");
      }),
      pruneEndpoints: vi.fn(),
      upsert: vi.fn(),
      deleteByEndpoint: vi.fn(),
    } as never;
    const result = await notifyAgentReply(
      { userId: "u", agentId: "a", replyText: "hi", title: "Sol" },
      { env: CONFIGURED_ENV, repository: repo, logger: testLogger },
    );
    expect(result).toEqual({ pushed: false, reason: "failed" });
    expect(testLogger.warn).toHaveBeenCalledWith(
      "[web-push] notifyAgentReply failed (non-fatal)",
      expect.objectContaining({ userId: "u", agentId: "a", error: "db down" }),
    );
  });

  test("never throws — a send error yields a non-fatal failure result", async () => {
    const repo = fakeRepo([ROW]);
    const sendBatch = vi.fn(async () => {
      throw new Error("push provider down");
    });
    const result = await notifyAgentReply(
      { userId: "u", agentId: "a", replyText: "hi", title: "Sol" },
      {
        env: CONFIGURED_ENV,
        repository: repo,
        sendBatch: sendBatch as never,
        logger: testLogger,
      },
    );
    expect(result).toEqual({ pushed: false, reason: "failed" });
  });
});
