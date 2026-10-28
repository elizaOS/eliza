/**
 * Google Chat ignores `thread.name` unless the create call says how to reply:
 * the default MESSAGE_REPLY_OPTION_UNSPECIFIED "starts a new thread" and
 * "ignores any thread ID or threadKey that's included" (spaces.messages.create).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.ts";

function serviceWithRecordedSends() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const runtime = { emitEvent: vi.fn() } as unknown as IAgentRuntime;
  const service = new GoogleChatService(runtime);
  vi.spyOn(service, "getAccessToken").mockResolvedValue("token");
  (service as unknown as { getState: () => { accountId: string } }).getState = () => ({
    accountId: "default",
  });
  service.fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ name: "spaces/AAA/messages/M1" }));
  }) as typeof fetch;
  return { service, sent };
}

describe("Google Chat send", () => {
  it("replies inside the thread it names", async () => {
    const { service, sent } = serviceWithRecordedSends();
    await service.sendMessage({
      space: "spaces/AAA",
      text: "on it",
      thread: "spaces/AAA/threads/T1",
    });
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/spaces/AAA/messages");
    expect(url.searchParams.get("messageReplyOption")).toBe("REPLY_MESSAGE_OR_FAIL");
    expect(sent[0]?.body.thread).toEqual({ name: "spaces/AAA/threads/T1" });
  });

  it("reports a missing thread without retrying in a new thread", async () => {
    const { service } = serviceWithRecordedSends();
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { message: "Thread not found" } }, { status: 404 })
    );
    service.fetchImpl = fetchImpl as typeof fetch;
    await expect(
      service.sendMessage({
        space: "spaces/AAA",
        text: "on it",
        thread: "spaces/AAA/threads/missing",
      })
    ).rejects.toThrow("Thread not found");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("starts a new message without a thread as before", async () => {
    const { service, sent } = serviceWithRecordedSends();
    await service.sendMessage({ space: "spaces/AAA", text: "hello" });
    expect(sent[0]?.url).toBe("https://chat.googleapis.com/v1/spaces/AAA/messages");
  });
});
