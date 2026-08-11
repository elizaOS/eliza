/**
 * Proves the proactive greeting delivery loop: claimed greetings become DM
 * sends exactly once, auth refresh short-circuits without consuming entries,
 * and malformed or failed entries are reported, never retried.
 */
import { describe, expect, mock, test } from "bun:test";
import { drainAndDeliverGreetings } from "../src/proactive-greeting-delivery";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("drainAndDeliverGreetings", () => {
  test("delivers each claimed greeting as a DM exactly once", async () => {
    const sent: Array<{ userId: string; content: string }> = [];
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            {
              sessionId: "platform:discord:111",
              platformUserId: "111",
              message: "Sam, you're all set",
            },
            {
              sessionId: "platform:discord:222",
              platformUserId: "222",
              message: "you're all set",
            },
          ],
        }),
      sendDirectMessage: async (userId, content) => {
        sent.push({ userId, content });
      },
    });

    expect(report).toEqual({
      claimed: 2,
      delivered: 2,
      malformed: 0,
      failed: 0,
      authRefreshed: false,
    });
    expect(sent).toEqual([
      { userId: "111", content: "Sam, you're all set" },
      { userId: "222", content: "you're all set" },
    ]);
  });

  test("401 refreshes auth and sends nothing (entries stay unclaimed server-side)", async () => {
    const refreshAuth = mock(async () => {});
    const sendDirectMessage = mock(async () => {});
    const report = await drainAndDeliverGreetings({
      drain: async () => jsonResponse({ error: "unauthorized" }, 401),
      sendDirectMessage,
      refreshAuth,
    });

    expect(report.authRefreshed).toBe(true);
    expect(report.claimed).toBe(0);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  test("non-OK drain reports the status and sends nothing", async () => {
    const events: Array<{ kind: string; status?: number }> = [];
    const report = await drainAndDeliverGreetings({
      drain: async () => jsonResponse({ error: "boom" }, 503),
      sendDirectMessage: async () => {
        throw new Error("must not send");
      },
      onEvent: (event) =>
        events.push({ kind: event.kind, status: event.status }),
    });

    expect(report.claimed).toBe(0);
    expect(events).toEqual([{ kind: "drain-failed", status: 503 }]);
  });

  test("a failed DM send is terminal: reported, not retried, later entries still delivered", async () => {
    const sent: string[] = [];
    const events: Array<{ kind: string; sessionId?: string | null }> = [];
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            {
              sessionId: "platform:discord:closed-dms",
              platformUserId: "closed",
              message: "you're all set",
            },
            {
              sessionId: "platform:discord:open-dms",
              platformUserId: "open",
              message: "you're all set",
            },
          ],
        }),
      sendDirectMessage: async (userId) => {
        if (userId === "closed") {
          throw new Error("Cannot send messages to this user (50007)");
        }
        sent.push(userId);
      },
      onEvent: (event) =>
        events.push({ kind: event.kind, sessionId: event.sessionId }),
    });

    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(1);
    expect(sent).toEqual(["open"]);
    expect(events).toEqual([
      { kind: "send-failed", sessionId: "platform:discord:closed-dms" },
      { kind: "delivered", sessionId: "platform:discord:open-dms" },
    ]);
  });

  test("malformed entries (missing user or empty message) are skipped, not sent", async () => {
    const sendDirectMessage = mock(async () => {});
    const report = await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            { sessionId: "no-user", message: "hello" },
            { sessionId: "no-message", platformUserId: "333" },
            { sessionId: "blank", platformUserId: "444", message: "   " },
            "not-an-object",
            null,
          ],
        }),
      sendDirectMessage,
    });

    expect(report.malformed).toBe(3);
    expect(report.delivered).toBe(0);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  test("oversize greeting content is truncated to Discord's 2000-char cap", async () => {
    let delivered = "";
    await drainAndDeliverGreetings({
      drain: async () =>
        jsonResponse({
          greetings: [
            {
              sessionId: "platform:discord:long",
              platformUserId: "555",
              message: "x".repeat(2500),
            },
          ],
        }),
      sendDirectMessage: async (_userId, content) => {
        delivered = content;
      },
    });
    expect(delivered).toHaveLength(2000);
  });

  test("a body without a greetings array claims nothing", async () => {
    const sendDirectMessage = mock(async () => {});
    const report = await drainAndDeliverGreetings({
      drain: async () => jsonResponse({ unexpected: true }),
      sendDirectMessage,
    });
    expect(report.claimed).toBe(0);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });
});
