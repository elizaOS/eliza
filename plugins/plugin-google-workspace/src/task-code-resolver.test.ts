import { describe, expect, it, vi } from "vitest";
import { GoogleTaskCodeResolver, type TaskCodeContext } from "./task-code-resolver.js";
import type { GoogleGmailMessageDetail, GoogleGmailMessageSummary } from "./types.js";

const now = 1800000000000;
const context: TaskCodeContext = {
  accountId: "google-account",
  actorId: "actor",
  agentId: "agent",
  taskId: "task",
  epoch: 1,
  providerOrigin: "https://provider.example",
  recipient: "user@example.com",
  senders: ["security@provider.example"],
  challengeId: "challenge-1",
  issuedAt: now - 1000,
  expiresAt: now + 60000,
  searchQuery: "reviewed-provider-query",
};
function message(id = "message"): GoogleGmailMessageSummary {
  return {
    externalId: id,
    threadId: "thread",
    subject: "Test verification",
    from: "Provider",
    fromEmail: "security@provider.example",
    replyTo: null,
    to: ["user@example.com"],
    cc: [],
    snippet: "",
    receivedAt: new Date(now).toISOString(),
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 0,
    triageReason: "",
    labels: [],
    htmlLink: null,
    metadata: {},
  };
}
function fixture() {
  let time = now;
  const google = {
    searchGmailMessagesPage: vi.fn(async () => ({
      messages: [message()],
      nextPageToken: null as string | null,
    })),
    getGmailMessageDetail: vi.fn(
      async ({ messageId }: { accountId: string; messageId: string }) => ({
        message: message(messageId),
        bodyText: "synthetic provider message",
      })
    ),
  };
  const authorize = vi.fn(async () => true),
    parse = vi.fn((_detail: GoogleGmailMessageDetail) => ({
      challengeId: "challenge-1",
      code: "123456",
      expiresAt: now + 60000,
    }));
  return {
    google,
    authorize,
    parse,
    setTime: (value: number) => {
      time = value;
    },
    resolver: new GoogleTaskCodeResolver({ google, authorize, parse, now: () => time }),
  };
}
const signal = () => new AbortController().signal;
describe("protected Google task code resolution", () => {
  it("returns only an opaque reference and consumes it once for the exact context", async () => {
    const f = fixture();
    const result = await f.resolver.resolve(context, signal());
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("123456");
    if (result.status !== "ready") throw new Error("Expected ready");
    expect(f.google.searchGmailMessagesPage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: context.accountId })
    );
    await expect(
      f.resolver.consumeForFill(result.valueRef, { ...context, accountId: "other" }, signal())
    ).rejects.toMatchObject({ code: "GOOGLE_TASK_CODE_UNAVAILABLE" });
    expect(await f.resolver.consumeForFill(result.valueRef, context, signal())).toBe("123456");
    await expect(f.resolver.consumeForFill(result.valueRef, context, signal())).rejects.toThrow();
  });
  it("refuses ambiguous, incomplete, expired and wrong-challenge results", async () => {
    const ambiguous = fixture();
    ambiguous.google.searchGmailMessagesPage.mockResolvedValue({
      messages: [message("a"), message("b")],
      nextPageToken: null,
    });
    expect(await ambiguous.resolver.resolve(context, signal())).toEqual({ status: "ambiguous" });
    const incomplete = fixture();
    incomplete.google.searchGmailMessagesPage.mockResolvedValue({
      messages: [message()],
      nextPageToken: "same",
    });
    expect(await incomplete.resolver.resolve(context, signal())).toEqual({ status: "incomplete" });
    const expired = fixture();
    expired.parse.mockReturnValue({
      challengeId: context.challengeId,
      code: "123456",
      expiresAt: now - 1,
    });
    expect(await expired.resolver.resolve(context, signal())).toEqual({ status: "expired" });
    const wrong = fixture();
    wrong.parse.mockReturnValue({
      challengeId: "old-attempt",
      code: "123456",
      expiresAt: now + 1000,
    });
    expect(await wrong.resolver.resolve(context, signal())).toEqual({ status: "missing" });
  });
  it("does not read bodies for wrong senders, recipients or times and rechecks read metadata", async () => {
    for (const changes of [
      { fromEmail: "attacker@example.com" },
      { to: ["other@example.com"] },
      { receivedAt: new Date(now - 10000).toISOString() },
    ]) {
      const f = fixture();
      f.google.searchGmailMessagesPage.mockResolvedValue({
        messages: [{ ...message(), ...changes }],
        nextPageToken: null,
      });
      expect(await f.resolver.resolve(context, signal())).toEqual({ status: "missing" });
      expect(f.google.getGmailMessageDetail).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.google.getGmailMessageDetail.mockResolvedValue({
      message: { ...message(), to: ["other@example.com"] },
      bodyText: "private",
    });
    expect(await f.resolver.resolve(context, signal())).toEqual({ status: "missing" });
    expect(f.parse).not.toHaveBeenCalled();
  });
  it("fences revoked, expired and concurrent consumption without leaking provider errors", async () => {
    const f = fixture();
    const result = await f.resolver.resolve(context, signal());
    if (result.status !== "ready") throw new Error("Expected ready");
    const taken = await Promise.allSettled([
      f.resolver.consumeForFill(result.valueRef, context, signal()),
      f.resolver.consumeForFill(result.valueRef, context, signal()),
    ]);
    expect(taken.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const second = await f.resolver.resolve(context, signal());
    if (second.status !== "ready") throw new Error("Expected ready");
    f.resolver.revoke();
    await expect(f.resolver.consumeForFill(second.valueRef, context, signal())).rejects.toThrow();
    f.google.getGmailMessageDetail.mockRejectedValue(new Error("secret-body-123456"));
    await expect(f.resolver.resolve(context, signal())).rejects.toThrow(
      "The task code is unavailable"
    );
  });
  it("rejects a late response after revocation and a handle after expiry", async () => {
    const f = fixture();
    f.google.getGmailMessageDetail.mockImplementation(async () => {
      f.resolver.revoke();
      return { message: message(), bodyText: "" };
    });
    await expect(f.resolver.resolve(context, signal())).rejects.toThrow();
    const g = fixture();
    const result = await g.resolver.resolve(context, signal());
    if (result.status !== "ready") throw new Error("Expected ready");
    g.setTime(now + 60001);
    await expect(g.resolver.consumeForFill(result.valueRef, context, signal())).rejects.toThrow();
  });
  it("does not search after cancellation or lost authorization", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(f.resolver.resolve(context, controller.signal)).rejects.toMatchObject({
      code: "GOOGLE_TASK_CODE_UNAVAILABLE",
    });
    expect(f.google.searchGmailMessagesPage).not.toHaveBeenCalled();
    f.authorize.mockResolvedValue(false);
    await expect(f.resolver.resolve(context, signal())).rejects.toMatchObject({
      code: "GOOGLE_TASK_CODE_UNAVAILABLE",
    });
    expect(f.google.searchGmailMessagesPage).not.toHaveBeenCalled();
  });
  it("does not read a second message after parser-triggered task revocation", async () => {
    const f = fixture();
    f.google.searchGmailMessagesPage.mockResolvedValue({
      messages: [message("first"), message("second")],
      nextPageToken: null,
    });
    f.parse.mockImplementation(() => {
      f.resolver.revoke();
      return { challengeId: context.challengeId, code: "123456", expiresAt: now + 60000 };
    });
    await expect(f.resolver.resolve(context, signal())).rejects.toMatchObject({
      code: "GOOGLE_TASK_CODE_UNAVAILABLE",
    });
    expect(f.google.getGmailMessageDetail).toHaveBeenCalledTimes(1);
  });
});
