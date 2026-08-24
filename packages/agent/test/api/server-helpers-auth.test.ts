/** Exercises server auth helper boundaries with deterministic request fixtures. */
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPendingWebSocketsForTests,
  applyCors,
  CORS_ALLOWED_HEADERS,
  extractAuthToken,
  isAllowedHost,
  isAuthorized,
  isBoundaryRoleAuthorized,
  isServerTokenAuthorized,
  isSharedTerminalClientId,
  MAX_PENDING_WEBSOCKETS_PER_PEER,
  normalizeWsClientId,
  pendingWebSocketCount,
  releasePendingWebSocket,
  resolveBoundaryRole,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
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

/**
 * Minimal request builder for helpers that only inspect headers and the peer
 * address. The optional remoteAddress is installed on the socket exactly like
 * RemoteForwardRequest does, so loopback-trust decisions see a real peer IP.
 */
class HeaderOnlyRequest extends http.IncomingMessage {
  constructor(headers: Record<string, string>, remoteAddress?: string) {
    const socket = new Socket();
    if (remoteAddress) {
      Object.defineProperty(socket, "remoteAddress", {
        value: remoteAddress,
        configurable: true,
      });
    }
    super(socket);
    this.headers = {};
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = value;
    }
  }
}

function requestWithHeaders(
  headers: Record<string, string>,
  remoteAddress?: string,
): http.IncomingMessage {
  return new HeaderOnlyRequest(headers, remoteAddress);
}

describe("isAllowedHost (DNS rebinding protection)", () => {
  beforeEach(() => {
    delete process.env.ELIZA_API_BIND;
    delete process.env.ELIZA_ALLOWED_HOSTS;
  });

  it("admits requests without a Host header (non-browser clients)", () => {
    expect(isAllowedHost(requestWithHeaders({}))).toBe(true);
  });

  it("admits a whitespace-only Host header", () => {
    expect(isAllowedHost(requestWithHeaders({ Host: "   " }))).toBe(true);
  });

  it("admits loopback hosts with an explicit port", () => {
    expect(isAllowedHost(requestWithHeaders({ Host: "localhost:31337" }))).toBe(
      true,
    );
    expect(isAllowedHost(requestWithHeaders({ Host: "[::1]:31337" }))).toBe(
      true,
    );
  });

  it("rejects a DNS-rebound non-loopback hostname", () => {
    expect(isAllowedHost(requestWithHeaders({ Host: "evil.example" }))).toBe(
      false,
    );
  });

  it("does not treat a loopback-prefixed subdomain as local", () => {
    expect(
      isAllowedHost(requestWithHeaders({ Host: "127.0.0.1.evil.com" })),
    ).toBe(false);
  });

  it("allows any Host while bound to a wildcard address", () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    expect(isAllowedHost(requestWithHeaders({ Host: "evil.example" }))).toBe(
      true,
    );
  });

  it("accepts an operator-allowlisted host after port stripping and case folding", () => {
    process.env.ELIZA_ALLOWED_HOSTS = "Dashboard.Example";
    expect(
      isAllowedHost(requestWithHeaders({ Host: "dashboard.example:8080" })),
    ).toBe(true);
  });

  it("accepts the exact configured bind hostname and still rejects others", () => {
    process.env.ELIZA_API_BIND = "agent.internal";
    expect(
      isAllowedHost(requestWithHeaders({ Host: "agent.internal:19687" })),
    ).toBe(true);
    expect(isAllowedHost(requestWithHeaders({ Host: "other.internal" }))).toBe(
      false,
    );
  });
});

describe("extractAuthToken credential extraction", () => {
  beforeEach(() => {
    delete process.env.ELIZA_ALLOW_WS_QUERY_TOKEN;
  });

  it("parses the Bearer scheme case-insensitively", () => {
    const req = requestWithHeaders({ Authorization: "bearer tok-1" });
    expect(extractAuthToken(req)).toBe("tok-1");
  });

  it("trims whitespace around the bearer credentials", () => {
    const req = requestWithHeaders({ Authorization: "Bearer   tok-2   " });
    expect(extractAuthToken(req)).toBe("tok-2");
  });

  it("returns null when the header carries a bare scheme without credentials", () => {
    const req = requestWithHeaders({ Authorization: "Bearer " });
    expect(extractAuthToken(req)).toBe(null);
  });

  it("reads X-Eliza-Token when no Authorization header is present", () => {
    const req = requestWithHeaders({ "X-Eliza-Token": "tok-3" });
    expect(extractAuthToken(req)).toBe("tok-3");
  });

  it("falls back to X-Api-Key and prefers the eliza token header over it", () => {
    expect(extractAuthToken(requestWithHeaders({ "X-Api-Key": "key-1" }))).toBe(
      "key-1",
    );
    expect(
      extractAuthToken(
        requestWithHeaders({
          "X-Eliza-Token": "eliza-1",
          "X-Api-Key": "key-1",
        }),
      ),
    ).toBe("eliza-1");
  });

  it("a blank X-Eliza-Token shadows a valid X-Api-Key rather than falling through", () => {
    expect(
      extractAuthToken(
        requestWithHeaders({
          "X-Eliza-Token": "   ",
          "X-Api-Key": "key-2",
        }),
      ),
    ).toBe(null);
  });

  it("ignores a duplicated (array-form) Authorization header", () => {
    const req = requestWithHeaders({});
    req.headers.authorization = ["Bearer tok-array"];
    expect(extractAuthToken(req)).toBe(null);
  });

  it("caps oversized Authorization headers at 8192 characters", () => {
    const req = requestWithHeaders({
      Authorization: `Bearer ${"x".repeat(9000)}`,
    });
    expect(extractAuthToken(req)).toBe("x".repeat(8185));
  });
});

describe("resolveTerminalRunRejection", () => {
  const TERMINAL_TOKEN = "terminal-secret";

  beforeEach(() => {
    delete process.env.ELIZA_TERMINAL_RUN_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.AGENT_SERVER_SHARED_SECRET;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.STEWARD_AGENT_TOKEN;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  afterEach(() => {
    delete process.env.ELIZA_TERMINAL_RUN_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
  });

  it("keeps legacy compatibility open when neither token is configured", () => {
    expect(resolveTerminalRunRejection(gatewayForward({}), {})).toBe(null);
  });

  it("disables command execution for token-authenticated sessions without a terminal token", () => {
    process.env.ELIZA_API_TOKEN = "api-tok";
    const rejection = resolveTerminalRunRejection(gatewayForward({}), {});
    expect(rejection?.status).toBe(403);
    expect(rejection?.reason).toContain("ELIZA_TERMINAL_RUN_TOKEN");
  });

  it("demands a credential when a terminal token is configured", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_TOKEN;
    const rejection = resolveTerminalRunRejection(gatewayForward({}), {});
    expect(rejection?.status).toBe(401);
    expect(rejection?.reason).toContain("Missing terminal token");
  });

  it("rejects a wrong header token", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_TOKEN;
    const rejection = resolveTerminalRunRejection(
      gatewayForward({ "X-Eliza-Terminal-Token": "wrong" }),
      {},
    );
    expect(rejection?.status).toBe(401);
    expect(rejection?.reason).toContain("Invalid terminal token");
  });

  it("accepts the correct token from either the header or the body", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_TOKEN;
    expect(
      resolveTerminalRunRejection(
        gatewayForward({ "X-Eliza-Terminal-Token": TERMINAL_TOKEN }),
        {},
      ),
    ).toBe(null);
    expect(
      resolveTerminalRunRejection(gatewayForward({}), {
        terminalToken: TERMINAL_TOKEN,
      }),
    ).toBe(null);
  });

  it("trims the body credential before comparing", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_TOKEN;
    expect(
      resolveTerminalRunRejection(gatewayForward({}), {
        terminalToken: `  ${TERMINAL_TOKEN}  `,
      }),
    ).toBe(null);
  });

  it("prefers a valid header token over an invalid body token", () => {
    process.env.ELIZA_TERMINAL_RUN_TOKEN = TERMINAL_TOKEN;
    expect(
      resolveTerminalRunRejection(
        gatewayForward({ "X-Eliza-Terminal-Token": TERMINAL_TOKEN }),
        { terminalToken: "wrong" },
      ),
    ).toBe(null);
  });
});

describe("terminal client id normalization and routing", () => {
  it("normalizes valid ids and trims surrounding whitespace", () => {
    expect(normalizeWsClientId("ui-terminal-1")).toBe("ui-terminal-1");
    expect(normalizeWsClientId("  ui-2  ")).toBe("ui-2");
  });

  it("rejects non-string, empty, and whitespace-only values", () => {
    expect(normalizeWsClientId(42)).toBe(null);
    expect(normalizeWsClientId(null)).toBe(null);
    expect(normalizeWsClientId("")).toBe(null);
    expect(normalizeWsClientId("    ")).toBe(null);
  });

  it("enforces the [A-Za-z0-9._-]{1,128} shape", () => {
    expect(normalizeWsClientId("bad id!")).toBe(null);
    expect(normalizeWsClientId("a".repeat(128))).toBe("a".repeat(128));
    expect(normalizeWsClientId("a".repeat(129))).toBe(null);
  });

  it("resolves the terminal client id from the header first, then the body", () => {
    expect(
      resolveTerminalRunClientId(
        gatewayForward({ "X-Eliza-Client-Id": "hdr-client" }),
        { clientId: "body-client" },
      ),
    ).toBe("hdr-client");
    expect(
      resolveTerminalRunClientId(gatewayForward({}), {
        clientId: "body-client",
      }),
    ).toBe("body-client");
  });

  it("returns null when neither the header nor the body carries a usable id", () => {
    expect(resolveTerminalRunClientId(gatewayForward({}), {})).toBe(null);
    expect(
      resolveTerminalRunClientId(gatewayForward({}), { clientId: "!!" }),
    ).toBe(null);
  });

  it("recognizes the shared runtime terminal client ids only", () => {
    expect(isSharedTerminalClientId("runtime-terminal-action")).toBe(true);
    expect(isSharedTerminalClientId("runtime-shell-action")).toBe(true);
    expect(isSharedTerminalClientId("some-private-session")).toBe(false);
  });
});

describe("resolveWebSocketUpgradeRejection", () => {
  beforeEach(() => {
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.AGENT_SERVER_SHARED_SECRET;
    delete process.env.ELIZA_ALLOW_WS_QUERY_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.STEWARD_AGENT_TOKEN;
    delete process.env.ELIZAOS_CLOUD_ENABLED;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  afterEach(() => {
    delete process.env.ELIZA_ALLOW_WS_QUERY_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.STEWARD_AGENT_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  });

  it("404s upgrades off the /ws pathname before any auth work", () => {
    const rejection = resolveWebSocketUpgradeRejection(
      requestWithHeaders({ Host: "127.0.0.1:31337" }, "127.0.0.1"),
      new URL("http://127.0.0.1:31337/not-ws"),
    );
    expect(rejection?.status).toBe(404);
  });

  it("403s a browser origin that CORS would never reflect", () => {
    const rejection = resolveWebSocketUpgradeRejection(
      requestWithHeaders(
        { Host: "203.0.113.7:19687", Origin: "https://evil.example" },
        "203.0.113.7",
      ),
      new URL("http://203.0.113.7:19687/ws"),
    );
    expect(rejection?.status).toBe(403);
    expect(rejection?.reason).toContain("Origin");
  });

  it("admits a credential-less upgrade from a trusted loopback peer when no API token is configured", () => {
    const rejection = resolveWebSocketUpgradeRejection(
      requestWithHeaders({ Host: "127.0.0.1:31337" }, "127.0.0.1"),
      new URL("http://127.0.0.1:31337/ws"),
    );
    expect(rejection).toBe(null);
  });

  it("rejects a credential-less upgrade from a non-loopback peer when no API token is configured", () => {
    const rejection = resolveWebSocketUpgradeRejection(
      requestWithHeaders({ Host: "203.0.113.7:19687" }, "203.0.113.7"),
      new URL("http://203.0.113.7:19687/ws"),
    );
    expect(rejection?.status).toBe(401);
  });

  it("rejects a mismatching Bearer credential during the handshake", () => {
    process.env.ELIZA_API_TOKEN = "api-tok";
    const rejection = resolveWebSocketUpgradeRejection(
      requestWithHeaders(
        { Host: "203.0.113.7:19687", Authorization: "Bearer wrong" },
        "203.0.113.7",
      ),
      new URL("http://203.0.113.7:19687/ws"),
    );
    expect(rejection?.status).toBe(401);
  });

  it("accepts the query-string token for browser handshakes when the flag is enabled", () => {
    process.env.ELIZA_API_TOKEN = "api-tok";
    process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
    const rejection = resolveWebSocketUpgradeRejection(
      requestWithHeaders({ Host: "203.0.113.7:19687" }, "203.0.113.7"),
      new URL("http://203.0.113.7:19687/ws?token=api-tok"),
    );
    expect(rejection).toBe(null);
  });

  it("admits a credential-less non-cloud upgrade for post-open auth but rejects cloud containers", () => {
    process.env.ELIZA_API_TOKEN = "api-tok";
    const admitted = resolveWebSocketUpgradeRejection(
      requestWithHeaders({ Host: "203.0.113.7:19687" }, "203.0.113.7"),
      new URL("http://203.0.113.7:19687/ws"),
    );
    expect(admitted).toBe(null);

    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward";
    const rejected = resolveWebSocketUpgradeRejection(
      requestWithHeaders({ Host: "203.0.113.7:19687" }, "203.0.113.7"),
      new URL("http://203.0.113.7:19687/ws"),
    );
    expect(rejected?.status).toBe(401);
  });
});

describe("boundary role resolution at the HTTP edge", () => {
  beforeEach(() => {
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.AGENT_SERVER_SHARED_SECRET;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  afterEach(() => {
    delete process.env.ELIZA_API_TOKEN;
  });

  it("collapses an authorized caller to OWNER and everyone else to GUEST", () => {
    process.env.ELIZA_API_TOKEN = "role-tok";
    expect(
      resolveBoundaryRole(gatewayForward({ Authorization: "Bearer role-tok" })),
    ).toBe("OWNER");
    expect(resolveBoundaryRole(gatewayForward({}))).toBe("GUEST");
  });

  it("falls through to trunk auth when no product boundary-role resolver claims the request", () => {
    expect(
      isBoundaryRoleAuthorized(gatewayForward({}), "POST", "/api/agents"),
    ).toBe(false);
  });
});
