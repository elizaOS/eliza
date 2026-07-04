/** Exercises renderer api proxy behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  createRendererApiProxyRequestInit,
  isRendererApiProxyPath,
  resolveRendererProxyIdleTimeoutSeconds,
  shouldProxyToApiBase,
} from "./renderer-api-proxy";

describe("renderer API proxy", () => {
  it("recognizes same-origin backend proxy paths", () => {
    expect(isRendererApiProxyPath("/api/status")).toBe(true);
    expect(isRendererApiProxyPath("/api/conversations/123/messages")).toBe(
      true,
    );
    expect(isRendererApiProxyPath("/ws")).toBe(true);
    expect(isRendererApiProxyPath("/music-player/state")).toBe(true);
    expect(isRendererApiProxyPath("/assets/main.js")).toBe(false);
  });

  it("does not attach a body or duplex flag to GET requests", () => {
    const req = new Request("http://127.0.0.1:5174/api/status", {
      headers: {
        connection: "keep-alive",
        host: "127.0.0.1:5174",
        "x-test": "1",
      },
    });
    const target = new URL("http://127.0.0.1:31337/api/status");

    const init = createRendererApiProxyRequestInit(req, target);

    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
    expect((init.headers as Headers).get("connection")).toBeNull();
    expect((init.headers as Headers).get("host")).toBeNull();
    expect((init.headers as Headers).get("x-test")).toBe("1");
  });

  it("forwards streaming bodies for POST requests", () => {
    const req = new Request("http://127.0.0.1:5174/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    const target = new URL("http://127.0.0.1:31337/api/config");

    const init = createRendererApiProxyRequestInit(req, target);

    expect(init.method).toBe("POST");
    expect(init.body).toBe(req.body);
    expect(init.duplex).toBe("half");
    expect((init.headers as Headers).get("host")).toBeNull();
  });

  it("proxies only to a reachable HTTP(S) api base, never the IPC scheme", () => {
    // Local mode with the port exposed (ELIZA_API_EXPOSE_PORT=1) / external /
    // cloud modes keep an HTTP listener the static server can forward to.
    expect(shouldProxyToApiBase("http://127.0.0.1:31337")).toBe(true);
    expect(shouldProxyToApiBase("https://agent.example.com")).toBe(true);

    // Default local-agent IPC mode: no listener, no forwarding target. The
    // proxy must stay dead so it never fetches a non-HTTP scheme.
    expect(shouldProxyToApiBase("eliza-local-agent://ipc")).toBe(false);
    expect(shouldProxyToApiBase(undefined)).toBe(false);
    expect(shouldProxyToApiBase("")).toBe(false);
    expect(shouldProxyToApiBase("not a url")).toBe(false);
  });

  it("keeps the renderer proxy idle timeout within Bun.serve limits", () => {
    expect(
      resolveRendererProxyIdleTimeoutSeconds({
        ELIZA_RENDERER_PROXY_IDLE_TIMEOUT_SECONDS: "660",
      }),
    ).toBe(255);
    expect(
      resolveRendererProxyIdleTimeoutSeconds({
        ELIZA_HTTP_REQUEST_TIMEOUT_MS: "660000",
      }),
    ).toBe(255);
    expect(
      resolveRendererProxyIdleTimeoutSeconds({
        ELIZA_CHAT_GENERATION_TIMEOUT_MS: "120000",
      }),
    ).toBe(180);
    expect(resolveRendererProxyIdleTimeoutSeconds({})).toBe(255);
  });
});
