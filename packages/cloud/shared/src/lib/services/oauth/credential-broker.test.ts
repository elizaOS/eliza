/**
 * Credential broker contract tests. Deterministic: the broker is exercised
 * with injected connection/token lookups and a protocol-faithful fetch stub —
 * no network, no database. Covers audience pinning, hostile header/URL input,
 * org/user binding, revoked/expired auth, token-egress redaction, upstream
 * failure, redirect non-following, and refresh idempotency metadata.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
  BROKER_PLATFORM_POLICIES,
  createCredentialBroker,
  validateBrokeredHeaders,
  validateBrokeredUrl,
} from "./credential-broker";
import { OAuthError, OAuthErrorCode } from "./errors";
import type { OAuthConnection, TokenResult } from "./types";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";
const OTHER_USER = "user-2";
const CONN = "11111111-1111-4111-8111-111111111111";
const SECRET = "super-secret-access-token";

function makeConnection(overrides: Partial<OAuthConnection> = {}): OAuthConnection {
  return {
    id: CONN,
    userId: USER,
    platform: "github",
    platformUserId: "gh-1",
    status: "active",
    scopes: ["repo"],
    linkedAt: new Date("2026-01-01T00:00:00Z"),
    tokenExpired: false,
    source: "platform_credentials",
    ...overrides,
  };
}

function makeToken(overrides: Partial<TokenResult> = {}): TokenResult {
  return {
    accessToken: SECRET,
    refreshed: false,
    fromCache: true,
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    scopes: ["repo"],
    ...overrides,
  };
}

interface Recorded {
  url: string;
  init: RequestInit;
}

function makeHarness(options?: {
  connection?: OAuthConnection | null;
  token?: TokenResult;
  upstream?: () => Response;
  failFetch?: Error;
}) {
  const recorded: Recorded[] = [];
  let tokenCalls = 0;
  const connection = options?.connection === undefined ? makeConnection() : options.connection;
  const broker = createCredentialBroker({
    getConnection: async ({ organizationId, connectionId }) => {
      if (organizationId !== ORG) return null;
      if (!connection || connection.id !== connectionId) return null;
      return connection;
    },
    getValidToken: async () => {
      tokenCalls += 1;
      return options?.token ?? makeToken();
    },
    fetchImpl: async (url: string, init?: RequestInit) => {
      recorded.push({ url, init: init ?? {} });
      if (options?.failFetch) throw options.failFetch;
      return options?.upstream
        ? options.upstream()
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              etag: 'W/"abc"',
              "set-cookie": "sid=leaky; HttpOnly",
              "x-ratelimit-remaining": "42",
              "x-internal-debug": "nope",
            },
          });
    },
  });
  return { broker, recorded, tokenCalls: () => tokenCalls };
}

const baseRequest = {
  method: "GET",
  url: "https://api.github.com/user/repos",
};

describe("validateBrokeredUrl (audience pinning)", () => {
  const policy = BROKER_PLATFORM_POLICIES.github;

  it("accepts an exact allowlisted https host", () => {
    expect(validateBrokeredUrl("https://api.github.com/repos", policy).hostname).toBe(
      "api.github.com",
    );
  });

  for (const [label, url] of [
    ["non-allowlisted host", "https://evil.example.com/repos"],
    ["subdomain of a pinned host", "https://api.github.com.evil.example/x"],
    ["lookalike prefix host", "https://eapi.github.com/x"],
    ["http scheme", "http://api.github.com/repos"],
    ["userinfo credentials", "https://token@api.github.com/repos"],
    ["explicit port", "https://api.github.com:8443/repos"],
    ["unparseable URL", "not a url"],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => validateBrokeredUrl(url, policy)).toThrow(OAuthError);
    });
  }
});

describe("validateBrokeredHeaders (hostile header input)", () => {
  const policy = BROKER_PLATFORM_POLICIES.github;

  it("accepts generic and platform-extra headers", () => {
    const validated = validateBrokeredHeaders(
      { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      policy,
    );
    expect(validated).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    });
  });

  for (const [label, headers] of [
    ["caller-supplied authorization", { Authorization: "Bearer attacker" }],
    ["cookie smuggling", { Cookie: "session=stolen" }],
    ["api-key smuggling", { "x-api-key": "attacker" }],
    ["eliza-internal header", { "x-eliza-session": "abc" }],
    ["host override", { Host: "evil.example.com" }],
    ["forwarded spoof", { "X-Forwarded-For": "10.0.0.1" }],
    ["CRLF header value injection", { accept: "text/html\r\nauthorization: Bearer x" }],
    ["non-allowlisted header", { "x-custom-tracking": "1" }],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => validateBrokeredHeaders(headers as Record<string, string>, policy)).toThrow(
        OAuthError,
      );
    });
  }
});

describe("CredentialBroker.callProvider", () => {
  it("injects the provider credential server-side and never echoes it", async () => {
    const { broker, recorded } = makeHarness();
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });

    const sentHeaders = recorded[0]!.init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe(`Bearer ${SECRET}`);
    expect(result.status).toBe(200);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("relays only allowlisted upstream headers (no set-cookie, no internals)", async () => {
    const { broker } = makeHarness();
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.headers).toEqual({
      "content-type": "application/json",
      etag: 'W/"abc"',
      "x-ratelimit-remaining": "42",
    });
    expect(result.bodyEncoding).toBe("utf8");
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it("does not follow upstream redirects with the credentialed request", async () => {
    const { broker, recorded } = makeHarness({
      upstream: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.init.redirect).toBe("manual");
    expect(result.status).toBe(302);
  });

  it("rejects a connection from another organization as not found", async () => {
    const { broker, recorded } = makeHarness();
    await expect(
      broker.callProvider({
        organizationId: OTHER_ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.CONNECTION_NOT_FOUND });
    expect(recorded).toHaveLength(0);
  });

  it("rejects another user's user-owned connection without leaking existence", async () => {
    const { broker } = makeHarness();
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: OTHER_USER,
        connectionId: CONN,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.CONNECTION_NOT_FOUND });
  });

  it("allows org-shared connections (no owning user)", async () => {
    const { broker } = makeHarness({ connection: makeConnection({ userId: undefined }) });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: OTHER_USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.status).toBe(200);
  });

  it("rejects revoked connections with a reconnect-required error", async () => {
    const { broker } = makeHarness({ connection: makeConnection({ status: "revoked" }) });
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.CONNECTION_REVOKED, reconnectRequired: true });
  });

  it("rejects expired connections", async () => {
    const { broker } = makeHarness({ connection: makeConnection({ status: "expired" }) });
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.CONNECTION_EXPIRED });
  });

  it("refuses platforms without an audience pin", async () => {
    const { broker } = makeHarness({ connection: makeConnection({ platform: "twilio" }) });
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: { method: "GET", url: "https://api.twilio.com/2010-04-01" },
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.PLATFORM_NOT_SUPPORTED });
  });

  it("rejects disallowed methods and GET bodies", async () => {
    const { broker } = makeHarness();
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: { ...baseRequest, method: "TRACE" },
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.INVALID_SCOPE_REQUEST });
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: { ...baseRequest, body: "nope" },
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.INVALID_SCOPE_REQUEST });
  });

  it("rejects oversized request bodies", async () => {
    const { broker } = makeHarness();
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: {
          method: "POST",
          url: "https://api.github.com/repos",
          body: "x".repeat(1_000_001),
        },
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.INVALID_SCOPE_REQUEST });
  });

  it("maps upstream transport failure to a typed error without token egress", async () => {
    const { broker } = makeHarness({ failFetch: new Error("ECONNRESET") });
    let caught: unknown;
    try {
      await broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe(OAuthErrorCode.INTERNAL_ERROR);
    expect((caught as OAuthError).message).not.toContain(SECRET);
  });

  it("passes through non-2xx provider responses (e.g. provider 401)", async () => {
    const { broker } = makeHarness({
      upstream: () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.status).toBe(401);
  });

  it("returns binary payloads base64-encoded", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const { broker } = makeHarness({
      upstream: () =>
        new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.bodyEncoding).toBe("base64");
    expect(Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});

/**
 * Response byte budget. The request side is capped at MAX_REQUEST_BODY_BYTES in
 * the same function; these pin the counterpart on the response so an
 * allowlisted host cannot decide how much memory the isolate spends.
 *
 * MAX_RESPONSE_BODY_BYTES is module-private by design (it is derived from the
 * request cap, not a second independent literal), so these tests assert the
 * observable contract at the boundary rather than importing the number.
 */
describe("CredentialBroker.callProvider (upstream response byte budget)", () => {
  const OVER_BUDGET_BYTES = 5_000_001;
  const AT_BUDGET_BYTES = 5_000_000;

  /** A body stream that would emit `totalBytes` if it were ever drained. */
  function chunkedBody(totalBytes: number, chunkBytes = 64 * 1024) {
    let emitted = 0;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= totalBytes) {
          controller.close();
          return;
        }
        pulls += 1;
        const size = Math.min(chunkBytes, totalBytes - emitted);
        emitted += size;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
    });
    return { stream, emitted: () => emitted, pulls: () => pulls };
  }

  it("rejects a declared content-length over budget without reading the body", async () => {
    const source = chunkedBody(OVER_BUDGET_BYTES);
    const { broker } = makeHarness({
      upstream: () =>
        new Response(source.stream, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(OVER_BUDGET_BYTES),
          },
        }),
    });
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.UPSTREAM_RESPONSE_TOO_LARGE });
    // Charged before allocation: the broker never drained the body. The stream
    // may have handed out at most the one chunk the runtime reads ahead when a
    // streaming Response is constructed, which is not the broker reading it.
    expect(source.pulls()).toBeLessThanOrEqual(1);
    expect(source.emitted()).toBeLessThanOrEqual(64 * 1024);
  });

  it("cuts off an undeclared over-budget stream instead of draining it", async () => {
    // 64 MiB of upstream with no content-length: the pre-check cannot help, so
    // the running total has to stop it. Retained bytes must stay near the
    // budget, not near what the host offered.
    const source = chunkedBody(64 * 1024 * 1024);
    const { broker } = makeHarness({
      upstream: () =>
        new Response(source.stream, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    await expect(
      broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.UPSTREAM_RESPONSE_TOO_LARGE });
    // Under 8% of what the host offered: the read stopped, it did not drain.
    expect(source.emitted()).toBeLessThan((64 * 1024 * 1024) / 12);
    // At most the budget, plus the chunk that crossed it, plus the runtime's
    // one-chunk readahead. Never a function of the 64 MiB the host offered.
    expect(source.emitted()).toBeLessThanOrEqual(AT_BUDGET_BYTES + 2 * 64 * 1024);
  });

  it("maps the over-budget failure to 502, not to a generic transport 500", async () => {
    const { broker } = makeHarness({
      upstream: () =>
        new Response(new Uint8Array(OVER_BUDGET_BYTES), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    let caught: unknown;
    try {
      await broker.callProvider({
        organizationId: ORG,
        userId: USER,
        connectionId: CONN,
        request: baseRequest,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe(OAuthErrorCode.UPSTREAM_RESPONSE_TOO_LARGE);
    expect((caught as OAuthError).httpStatus).toBe(502);
    expect((caught as OAuthError).reconnectRequired).toBe(false);
    // No silent truncation served as success, and no token echo in the message.
    expect((caught as OAuthError).message).not.toContain(SECRET);
  });

  it("accepts a large-but-bounded response whole, byte for byte", async () => {
    const size = AT_BUDGET_BYTES;
    const source = chunkedBody(size);
    const { broker } = makeHarness({
      upstream: () =>
        new Response(source.stream, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.status).toBe(200);
    expect(result.bodyEncoding).toBe("base64");
    // base64 of `size` bytes, reassembled across many stream chunks.
    expect(result.body.length).toBe(Math.ceil(size / 3) * 4);
    expect(source.emitted()).toBe(size);
  });

  it("reassembles a multi-chunk textual body identically to a single-shot read", async () => {
    const payload = JSON.stringify({ items: Array.from({ length: 4096 }, (_, i) => ({ i })) });
    const encoded = new TextEncoder().encode(payload);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= encoded.byteLength) {
          controller.close();
          return;
        }
        // 7 bytes at a time: splits multi-byte boundaries and proves the merge
        // is a byte concatenation, not a per-chunk decode.
        const end = Math.min(offset + 7, encoded.byteLength);
        controller.enqueue(encoded.slice(offset, end));
        offset = end;
      },
    });
    const { broker } = makeHarness({
      upstream: () =>
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.bodyEncoding).toBe("utf8");
    expect(result.body).toBe(payload);
  });

  it("ignores an absent or unparseable content-length and falls back to counting", async () => {
    const { broker } = makeHarness({
      upstream: () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "not-a-number" },
        }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe(JSON.stringify({ ok: true }));
  });

  it("still accepts an empty 204 body", async () => {
    const { broker } = makeHarness({
      upstream: () => new Response(null, { status: 204 }),
    });
    const result = await broker.callProvider({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
      request: baseRequest,
    });
    expect(result.status).toBe(204);
    expect(result.body).toBe("");
    expect(result.bodyEncoding).toBe("utf8");
  });
});

describe("CredentialBroker.refreshToken", () => {
  let refreshedToken: TokenResult;

  beforeEach(() => {
    refreshedToken = makeToken({ refreshed: true, fromCache: false });
  });

  it("returns refresh metadata with zero token material", async () => {
    const { broker } = makeHarness({ token: refreshedToken });
    const result = await broker.refreshToken({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
    });
    expect(result).toEqual({
      connectionId: CONN,
      platform: "github",
      status: "active",
      refreshed: true,
      expiresAt: "2026-12-01T00:00:00.000Z",
      scopes: ["repo"],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("reports refreshed=false when the cached token is still valid (idempotent repeat)", async () => {
    const { broker, tokenCalls } = makeHarness();
    const first = await broker.refreshToken({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
    });
    const second = await broker.refreshToken({
      organizationId: ORG,
      userId: USER,
      connectionId: CONN,
    });
    expect(first.refreshed).toBe(false);
    expect(second.refreshed).toBe(false);
    expect(tokenCalls()).toBe(2);
  });

  it("enforces org binding on refresh", async () => {
    const { broker } = makeHarness();
    await expect(
      broker.refreshToken({ organizationId: OTHER_ORG, userId: USER, connectionId: CONN }),
    ).rejects.toMatchObject({ code: OAuthErrorCode.CONNECTION_NOT_FOUND });
  });
});
