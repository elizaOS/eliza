/** Exercises server auth helper boundaries with deterministic request fixtures. */
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPendingWebSocketsForTests,
  applyCors,
  CORS_ALLOWED_HEADERS,
  isAuthorized,
  isServerTokenAuthorized,
  MAX_PENDING_WEBSOCKETS_PER_PEER,
  pendingWebSocketCount,
  releasePendingWebSocket,
  tryAcquirePendingWebSocket,
} from "../../src/api/server-helpers-auth";

class HeaderCapture extends http.ServerResponse {
  readonly headers = new Map<string, string | number | readonly string[]>();

  constructor() {
    super(new http.IncomingMessage(new Socket()));
  }

  override setHeader(name: string, value: string | number | readonly string[]) {
    super.setHeader(name, value);
    this.headers.set(name, value);
    return this;
  }
}

class RequestWithOrigin extends http.IncomingMessage {
  constructor(origin: string) {
    super(new Socket());
    this.headers = {};
    this.headers.host = "127.0.0.1:31337";
    this.headers.origin = origin;
  }
}

function requestWithOrigin(origin: string): http.IncomingMessage {
  return new RequestWithOrigin(origin);
}

describe("applyCors", () => {
  beforeEach(() => {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_API_BIND;
    delete process.env.ELIZA_ALLOWED_ORIGINS;
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.WAIFU_CHAT_FRAME_ANCESTORS;
  });

  it("allows app-core client headers used by Capacitor WebViews", () => {
    const res = new HeaderCapture();

    expect(
      applyCors(requestWithOrigin("https://localhost"), res, "/api/status"),
    ).toBe(true);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      CORS_ALLOWED_HEADERS,
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );

    const allowedHeaders = String(
      res.headers.get("Access-Control-Allow-Headers"),
    );
    expect(allowedHeaders).toContain("X-ElizaOS-Client-Id");
    expect(allowedHeaders).toContain("X-ElizaOS-UI-Language");
    expect(allowedHeaders).toContain("X-ElizaOS-Token");
    expect(allowedHeaders).toContain("X-Waifu-Chat-Access-Token");
  });

  it("never enables ambient browser credentials for reflected cloud origins", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const res = new HeaderCapture();

    expect(
      applyCors(
        requestWithOrigin("https://untrusted.example"),
        res,
        "/api/status",
      ),
    ).toBe(true);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://untrusted.example",
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeUndefined();
  });

  it("retains credentials for an explicitly configured browser origin", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_ALLOWED_ORIGINS = "https://trusted.example";
    const res = new HeaderCapture();

    expect(
      applyCors(
        requestWithOrigin("https://trusted.example"),
        res,
        "/api/status",
      ),
    ).toBe(true);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://trusted.example",
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("retains credentials for an app-owned WebView origin", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const res = new HeaderCapture();

    expect(
      applyCors(requestWithOrigin("capacitor://localhost"), res, "/api/status"),
    ).toBe(true);

    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("never grants ambient credentials to file origins", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const res = new HeaderCapture();

    expect(
      applyCors(
        requestWithOrigin("file:///tmp/index.html"),
        res,
        "/api/status",
      ),
    ).toBe(true);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "file:///tmp/index.html",
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeUndefined();
  });

  it("allows waifu token-page iframe ancestors when hosted chat JWT auth is enabled", () => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    const res = new HeaderCapture();

    expect(
      applyCors(requestWithOrigin("https://waifu.fun"), res, "/chat"),
    ).toBe(true);

    expect(res.headers.get("X-Frame-Options")).toBeUndefined();
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://waifu.fun https://*.waifu.fun",
    );
  });
});

describe("CORS advertises gateway + product headers", () => {
  it("advertises X-Server-Token so gateway forwards pass CORS preflight", () => {
    const res = new HeaderCapture();
    applyCors(requestWithOrigin("https://localhost"), res, "/api/status");
    const allowedHeaders = String(
      res.headers.get("Access-Control-Allow-Headers"),
    );
    expect(allowedHeaders).toContain("X-Server-Token");
  });
});

/**
 * Simulate the network shape of a cloud gateway forwarding a platform message
 * to a provisioned container: a remote (non-loopback) request to
 * /agents/:id/message. Headers can carry X-Server-Token and/or Authorization.
 */
class RemoteForwardRequest extends http.IncomingMessage {
  constructor(headers: Record<string, string>) {
    const socket = new Socket();
    // Force a non-loopback remote address so the trusted-local short-circuit
    // in isAuthorized never applies (mirrors a real off-node gateway).
    Object.defineProperty(socket, "remoteAddress", {
      value: "203.0.113.7",
      configurable: true,
    });
    super(socket);
    this.headers = {};
    this.headers.host = "203.0.113.7:19687";
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = value;
    }
  }
}

function gatewayForward(headers: Record<string, string>): http.IncomingMessage {
  return new RemoteForwardRequest(headers);
}

describe("isServerTokenAuthorized / X-Server-Token gateway auth", () => {
  const SECRET = "shared-secret-abc123";

  beforeEach(() => {
    delete process.env.AGENT_SERVER_SHARED_SECRET;
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.STEWARD_AGENT_TOKEN;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  afterEach(() => {
    delete process.env.AGENT_SERVER_SHARED_SECRET;
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  });

  it("authorizes a request whose X-Server-Token matches the shared secret", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = SECRET;
    const req = gatewayForward({ "X-Server-Token": SECRET });
    expect(isServerTokenAuthorized(req)).toBe(true);
    expect(isAuthorized(req)).toBe(true);
  });

  it("rejects a wrong X-Server-Token", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = SECRET;
    const req = gatewayForward({ "X-Server-Token": "not-the-secret" });
    expect(isServerTokenAuthorized(req)).toBe(false);
    expect(isAuthorized(req)).toBe(false);
  });

  it("rejects a missing X-Server-Token when the secret is configured", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = SECRET;
    const req = gatewayForward({});
    expect(isServerTokenAuthorized(req)).toBe(false);
    expect(isAuthorized(req)).toBe(false);
  });

  it("disables the X-Server-Token path entirely when the secret is unset", () => {
    // No AGENT_SERVER_SHARED_SECRET -> the header carries no authority, so even
    // a request presenting one is rejected (no Bearer / loopback either).
    const req = gatewayForward({ "X-Server-Token": SECRET });
    expect(isServerTokenAuthorized(req)).toBe(false);
    expect(isAuthorized(req)).toBe(false);
  });

  it("does not let an empty/whitespace secret authorize anything", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = "   ";
    const req = gatewayForward({ "X-Server-Token": "   " });
    expect(isServerTokenAuthorized(req)).toBe(false);
    expect(isAuthorized(req)).toBe(false);
  });

  it("still honors Bearer ELIZA_API_TOKEN when no X-Server-Token is present", () => {
    process.env.ELIZA_API_TOKEN = "agent-token-xyz";
    const req = gatewayForward({ Authorization: "Bearer agent-token-xyz" });
    expect(isAuthorized(req)).toBe(true);
  });

  it("accepts X-Server-Token even when an unrelated Bearer token is wrong", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = SECRET;
    process.env.ELIZA_API_TOKEN = "agent-token-xyz";
    const req = gatewayForward({
      "X-Server-Token": SECRET,
      Authorization: "Bearer wrong-bearer",
    });
    expect(isAuthorized(req)).toBe(true);
  });

  it("rejects when neither X-Server-Token nor Bearer match", () => {
    process.env.AGENT_SERVER_SHARED_SECRET = SECRET;
    process.env.ELIZA_API_TOKEN = "agent-token-xyz";
    const req = gatewayForward({
      "X-Server-Token": "nope",
      Authorization: "Bearer also-nope",
    });
    expect(isAuthorized(req)).toBe(false);
  });
});

/**
 * Simulate an SSE handshake from a browser EventSource: a remote (non-loopback)
 * GET to a streaming endpoint with `Accept: text/event-stream` and the API
 * token smuggled in the query string because EventSource cannot set headers.
 */
class RemoteSseRequest extends http.IncomingMessage {
  constructor(
    method: string,
    url: string,
    headers: Record<string, string> = {},
  ) {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", {
      value: "203.0.113.7",
      configurable: true,
    });
    super(socket);
    this.method = method;
    this.url = url;
    this.headers = {};
    this.headers.host = "203.0.113.7:19687";
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = value;
    }
  }
}

describe("SSE query-token auth (?token= for EventSource)", () => {
  const API_TOKEN = "agent_abc123";

  beforeEach(() => {
    delete process.env.AGENT_SERVER_SHARED_SECRET;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_ALLOW_WS_QUERY_TOKEN;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    process.env.ELIZA_API_TOKEN = API_TOKEN;
  });

  afterEach(() => {
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_ALLOW_WS_QUERY_TOKEN;
  });

  it("authorizes a GET SSE handshake carrying the correct ?token= when the flag is on", () => {
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const req = new RemoteSseRequest(
      "GET",
      `/api/conversations/conv-1/messages/stream?token=${API_TOKEN}`,
      { Accept: "text/event-stream" },
    );
    expect(isAuthorized(req)).toBe(true);
  });

  it("rejects a GET SSE handshake with a wrong ?token=", () => {
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const req = new RemoteSseRequest(
      "GET",
      "/api/conversations/conv-1/messages/stream?token=wrong",
      { Accept: "text/event-stream" },
    );
    expect(isAuthorized(req)).toBe(false);
  });

  it("rejects ?token= when ELIZA_ALLOW_WS_QUERY_TOKEN is unset (non-cloud deploys stay locked)", () => {
    // Flag NOT set -> SSE query token must be ignored entirely, even if correct.
    const req = new RemoteSseRequest(
      "GET",
      `/api/conversations/conv-1/messages/stream?token=${API_TOKEN}`,
      { Accept: "text/event-stream" },
    );
    expect(isAuthorized(req)).toBe(false);
  });

  it("rejects ?token= on non-SSE Accept (scope is text/event-stream only)", () => {
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const req = new RemoteSseRequest(
      "GET",
      `/api/whatever?token=${API_TOKEN}`,
      { Accept: "application/json" },
    );
    expect(isAuthorized(req)).toBe(false);
  });

  it("rejects ?token= on POST even with SSE Accept (read-only safety)", () => {
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const req = new RemoteSseRequest(
      "POST",
      `/api/conversations/conv-1/messages/stream?token=${API_TOKEN}`,
      { Accept: "text/event-stream" },
    );
    expect(isAuthorized(req)).toBe(false);
  });

  it("still prefers Bearer over ?token= when both are present", () => {
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const req = new RemoteSseRequest(
      "GET",
      "/api/conversations/conv-1/messages/stream?token=wrong",
      { Accept: "text/event-stream", Authorization: `Bearer ${API_TOKEN}` },
    );
    expect(isAuthorized(req)).toBe(true);
  });
});

describe("unauthenticated WebSocket pending-socket bounds (W5-015)", () => {
  afterEach(() => {
    __resetPendingWebSocketsForTests();
  });

  it("admits pre-auth sockets up to the per-peer cap, then refuses", () => {
    for (let i = 0; i < MAX_PENDING_WEBSOCKETS_PER_PEER; i++) {
      expect(tryAcquirePendingWebSocket("203.0.113.10")).toBe(true);
    }
    expect(pendingWebSocketCount("203.0.113.10")).toBe(
      MAX_PENDING_WEBSOCKETS_PER_PEER,
    );
    expect(tryAcquirePendingWebSocket("203.0.113.10")).toBe(false);
    expect(pendingWebSocketCount("203.0.113.10")).toBe(
      MAX_PENDING_WEBSOCKETS_PER_PEER,
    );
  });

  it("tracks caps independently per peer", () => {
    for (let i = 0; i < MAX_PENDING_WEBSOCKETS_PER_PEER; i++) {
      expect(tryAcquirePendingWebSocket("203.0.113.10")).toBe(true);
    }
    expect(tryAcquirePendingWebSocket("198.51.100.7")).toBe(true);
  });

  it("releases slots back down to zero and tolerates over-release", () => {
    expect(tryAcquirePendingWebSocket("203.0.113.10")).toBe(true);
    expect(tryAcquirePendingWebSocket("203.0.113.10")).toBe(true);
    releasePendingWebSocket("203.0.113.10");
    expect(pendingWebSocketCount("203.0.113.10")).toBe(1);
    releasePendingWebSocket("203.0.113.10");
    expect(pendingWebSocketCount("203.0.113.10")).toBe(0);
    // Releasing a peer with no held slots is a no-op, not a negative count.
    releasePendingWebSocket("203.0.113.10");
    expect(pendingWebSocketCount("203.0.113.10")).toBe(0);
    expect(tryAcquirePendingWebSocket("203.0.113.10")).toBe(true);
  });

  it("buckets a missing peer address under the shared unknown key", () => {
    expect(tryAcquirePendingWebSocket(undefined)).toBe(true);
    expect(pendingWebSocketCount(null)).toBe(1);
    releasePendingWebSocket(undefined);
    expect(pendingWebSocketCount(undefined)).toBe(0);
  });
});
