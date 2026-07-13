import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base.ts";

describe("navigation-aborted chat stream", () => {
  it("does not manufacture a provider failure for an empty interruption", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: true, value: undefined });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({
      request: vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          body: { getReader: () => ({ read, cancel: vi.fn() }) },
        } as unknown as Response;
      }),
    });

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "open settings",
      vi.fn(),
    );

    expect(result).toMatchObject({ text: "", completed: false });
    expect(result.text).not.toContain("couldn't generate");
  });
});
