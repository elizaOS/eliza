/** A selected encrypted relay is REST/SSE-only and must never dial ws://session. */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import type { AgentRequestTransport } from "./transport";

const originalWebSocket = globalThis.WebSocket;

describe("ElizaClient encrypted relay connection state", () => {
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom must clear the synchronous cookie read by production.
    document.cookie = "eliza_csrf=; Max-Age=0; path=/";
  });

  it("reports connected-over-REST without constructing a WebSocket", () => {
    const websocket = vi.fn();
    globalThis.WebSocket = websocket as unknown as typeof WebSocket;
    const client = new ElizaClient(
      "eliza-remote://session/11111111-1111-4111-8111-111111111111",
      "ambient-controller-token",
    );

    client.connectWs();

    expect(websocket).not.toHaveBeenCalled();
    expect(client.getConnectionState()).toMatchObject({
      state: "connected",
      reconnectAttempt: 0,
    });
  });

  it("does not leak an ambient browser CSRF credential into relay commands", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom must seed the synchronous cookie read by production.
    document.cookie = "eliza_csrf=browser-session-value; path=/";
    let capturedHeaders = new Headers();
    const transport: AgentRequestTransport = {
      async request(_url, init) {
        capturedHeaders = new Headers(init.headers);
        return Response.json({ conversation: {} });
      },
    };
    const client = new ElizaClient(
      "eliza-remote://session/11111111-1111-4111-8111-111111111111",
      "ambient-controller-token",
    );
    client.setRequestTransport(transport);

    await client.rawRequest("/api/conversations", {
      method: "POST",
      body: "{}",
    });

    expect(capturedHeaders.has("x-eliza-csrf")).toBe(false);
    expect(capturedHeaders.has("authorization")).toBe(false);
  });
});
