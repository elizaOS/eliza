import crypto from "node:crypto";
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCors,
  CORS_ALLOWED_HEADERS,
  isAuthorized,
  isServerTokenAuthorized,
  isWaifuChatAuthorized,
  resolveWaifuChatAccessToken,
  waifuChatRoleToWorldRole,
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

function signWaifuJwt(
  payload: Record<string, unknown>,
  secret = "waifu-secret",
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function requestWithBearer(token: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = {};
  req.headers.authorization = `Bearer ${token}`;
  req.headers.host = "agent.example";
  return req;
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

    const allowedHeaders = String(
      res.headers.get("Access-Control-Allow-Headers"),
    );
    expect(allowedHeaders).toContain("X-ElizaOS-Client-Id");
    expect(allowedHeaders).toContain("X-ElizaOS-UI-Language");
    expect(allowedHeaders).toContain("X-ElizaOS-Token");
    expect(allowedHeaders).toContain("X-Waifu-Chat-Access-Token");
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

describe("waifu chat JWT auth", () => {
  const futureExp = () => Math.floor(Date.now() / 1000) + 60;

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    process.env.TOKEN_CONTRACT_ADDRESS =
      "0x2222222222222222222222222222222222222222";
    process.env.TOKEN_CHAIN_ID = "56";
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.TOKEN_CONTRACT_ADDRESS;
    delete process.env.TOKEN_CHAIN_ID;
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  it("verifies issuer, audience, expiry, signature, wallet, and token scope", () => {
    const token = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: 2_000,
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
      cloudAgentId: "cloud-agent-1",
      balanceTokens: 100_001,
    });

    expect(resolveWaifuChatAccessToken(token, 1_000)).toEqual({
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
      cloudAgentId: "cloud-agent-1",
      balanceTokens: 100_001,
    });

    expect(resolveWaifuChatAccessToken(`${token}tampered`, 1_000)).toBeNull();
    expect(resolveWaifuChatAccessToken(token, 2_001)).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt({
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          exp: 2_000,
          role: "user",
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAddress: "0x3333333333333333333333333333333333333333",
          chainId: 56,
        }),
        1_000,
      ),
    ).toBeNull();
  });

  it("binds waifu chat JWTs to the hosted cloud agent id when configured", () => {
    process.env.WAIFU_ELIZA_CLOUD_AGENT_ID = "cloud-agent-1";
    const token = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "guest",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
      cloudAgentId: "cloud-agent-1",
    });

    expect(resolveWaifuChatAccessToken(token)?.cloudAgentId).toBe(
      "cloud-agent-1",
    );
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt({
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          exp: futureExp(),
          role: "guest",
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAddress: "0x2222222222222222222222222222222222222222",
          chainId: 56,
          cloudAgentId: "cloud-agent-2",
        }),
      ),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt({
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          exp: futureExp(),
          role: "guest",
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAddress: "0x2222222222222222222222222222222222222222",
          chainId: 56,
        }),
      ),
    ).toBeNull();
  });

  it("accepts waifu admin, user, and guest chat roles", () => {
    const cases = [
      { role: "admin", worldRole: "OWNER" },
      { role: "user", worldRole: "USER" },
      { role: "guest", worldRole: "GUEST" },
    ] as const;

    for (const { role, worldRole } of cases) {
      const token = signWaifuJwt({
        iss: "waifu.fun",
        aud: "eliza-cloud-chat",
        exp: futureExp(),
        role,
        walletAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0x2222222222222222222222222222222222222222",
        chainId: 56,
      });

      expect(resolveWaifuChatAccessToken(token)?.role).toBe(role);
      expect(waifuChatRoleToWorldRole(role)).toBe(worldRole);
    }
  });

  it("scopes guest and user JWTs to chat-safe routes while admin can use owner UI routes", () => {
    const guestToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "guest",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });
    const userToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });
    const adminToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "admin",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken),
        "POST",
        "/api/conversations/conv-1/messages/stream",
      ),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(userToken),
        "POST",
        "/api/conversations/conv-1/messages/stream",
      ),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken),
        "POST",
        "/api/config",
      ),
    ).toBe(false);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(userToken),
        "POST",
        "/api/config",
      ),
    ).toBe(false);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(adminToken),
        "POST",
        "/api/config",
      ),
    ).toBe(true);
  });

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
