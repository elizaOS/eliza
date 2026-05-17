import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

describe("ElizaClient agent streaming transport", () => {
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
