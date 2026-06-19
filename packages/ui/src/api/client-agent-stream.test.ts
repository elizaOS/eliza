import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

describe("ElizaClient agent streaming transport", () => {
  it("resolves chat streams immediately after a terminal done event", async () => {
    const encoder = new TextEncoder();
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: encoder.encode(
          'data: {"type":"token","text":"hi","fullText":"hi"}\n\n' +
            'data: {"type":"done","fullText":"hi","agentName":"Eliza"}\n\n',
        ),
      })
      .mockRejectedValueOnce(new Error("read after terminal event"));
    const cancel = vi.fn(async () => {});
    const request = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({ read, cancel }),
        },
      } as unknown as Response;
    });
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const onToken = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/conversation-id/messages/stream",
      "hello",
      onToken,
    );

    expect(result).toEqual({
      text: "hi",
      agentName: "Eliza",
      completed: true,
    });
    expect(onToken).toHaveBeenCalledWith("hi", "hi");
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("elizaos-sse-terminal-done");
  });

  it("streams security audit events through the configured request transport", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const request = vi.fn(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: entry\ndata: {"type":"entry","severity":"info"}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = new ElizaClient("eliza-local-agent://ipc", "local-token");
    client.setRequestTransport({ request });
    const onEvent = vi.fn();

    await client.streamSecurityAudit(onEvent);

    expect(request).toHaveBeenCalledWith(
      "eliza-local-agent://ipc/api/security/audit?stream=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer local-token",
        }),
      }),
      expect.any(Object),
    );
    expect(globalFetch).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      type: "entry",
      severity: "info",
    });

    vi.unstubAllGlobals();
  });
});
