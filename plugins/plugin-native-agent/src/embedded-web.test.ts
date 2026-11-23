/** The `EmbeddedAgent` web fallback keeps one abort handle per live stream id. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbeddedAgentWeb } from "./embedded-web";

describe("EmbeddedAgentWeb streams", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an aborted stream's end does not forget a newer stream with the same id", async () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage = null;
      },
    );
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodies.push(controller);
            init.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const agent = new EmbeddedAgentWeb();
    const ends: unknown[] = [];
    await agent.addListener("streamEnd", (end) => ends.push(end));
    const request = {
      id: "stream-01",
      method: "POST" as const,
      path: "/api/conversations/c1/messages/stream",
      body: { text: "hi" },
    };

    await agent.requestStream(request);
    // The page stops a reply and sends the next one at once, reusing its id.
    const stopped = agent.abort({ id: "stream-01" });
    const next = agent.requestStream(request);
    await expect(stopped).resolves.toEqual({ aborted: true });
    await next;
    await vi.waitFor(() =>
      expect(ends).toEqual([{ id: "stream-01", aborted: true }]),
    );

    await expect(agent.abort({ id: "stream-01" })).resolves.toEqual({
      aborted: true,
    });
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    expect(bodies).toHaveLength(2);
  });
});
