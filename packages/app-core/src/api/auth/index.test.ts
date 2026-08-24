/**
 * Covers the auth subsystem barrel the way consumers reach it: every case
 * imports from `./index.js` and drives a re-exported function against real
 * inputs — timing-safe token comparison, header extraction, cookie
 * parse/serialize round-trips, HMAC CSRF derivation, argon2id password
 * hashing against the installed native binary, audit metadata redaction,
 * the sensitive-route limiter state machine, request credential
 * classification, and the sync compat gate. Harness is deterministic:
 * hand-built Node req/res objects, fixed clocks for limiter windows, no
 * module mocks.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAuthRateLimiter,
  _resetSensitiveLimiters,
  assertPasswordStrong,
  bootstrapExchangeLimiter,
  CSRF_COOKIE_NAME,
  deriveCsrfToken,
  ensureAuthSessionOrBootstrap,
  ensureCompatApiAuthorized,
  extractHeaderValue,
  getProvidedApiToken,
  getSensitiveLimiter,
  getSessionCookieName,
  hashPassword,
  isDevEnvironment,
  PASSWORD_MIN_LENGTH,
  parseCookieHeader,
  parseSessionCookie,
  readCookie,
  redactMetadata,
  SENSITIVE_RATE_LIMIT_MAX,
  SENSITIVE_RATE_LIMIT_WINDOW_MS,
  SESSION_COOKIE_NAME,
  serializeCsrfCookie,
  serializeCsrfExpiryCookie,
  serializeSessionCookie,
  serializeSessionExpiryCookie,
  tokenMatches,
  verifyCsrfToken,
  verifyPassword,
  WeakPasswordError,
} from "./index.js";

function makeReq(
  headers: http.IncomingHttpHeaders,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
  return req;
}

function fakeRes(): { res: http.ServerResponse; status(): number } {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = (() => res) as typeof res.end;
  return { res, status: () => res.statusCode };
}

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");

describe("tokenMatches", () => {
  it("accepts equal tokens", () => {
    expect(tokenMatches("secret-token-value", "secret-token-value")).toBe(true);
  });

  it("rejects equal-length tokens with different content", () => {
    expect(tokenMatches("secret-token-value", "secret-token-valuf")).toBe(
      false,
    );
  });

  it("rejects a strict prefix (the length check folds into the result)", () => {
    expect(tokenMatches("secret-token-value", "secret-token")).toBe(false);
  });
});

describe("extractHeaderValue", () => {
  it("passes a string header through unchanged", () => {
    expect(extractHeaderValue("single")).toBe("single");
  });

  it("takes the first value of an array header", () => {
    expect(extractHeaderValue(["first", "second"])).toBe("first");
  });

  it("returns null for an absent header", () => {
    expect(extractHeaderValue(undefined)).toBe(null);
  });

  it("returns null for an empty array header", () => {
    expect(extractHeaderValue([])).toBe(null);
  });
});

describe("getProvidedApiToken", () => {
  it("extracts the credentials of a Bearer Authorization header", () => {
    expect(
      getProvidedApiToken(makeReq({ authorization: "Bearer tok-1" })),
    ).toBe("tok-1");
  });

  it("accepts a case-insensitive scheme with extra spaces", () => {
    expect(
      getProvidedApiToken(makeReq({ authorization: "bearer   tok-2" })),
    ).toBe("tok-2");
  });

  it("falls back to x-eliza-token when Authorization is absent", () => {
    expect(getProvidedApiToken(makeReq({ "x-eliza-token": "tok-3" }))).toBe(
      "tok-3",
    );
  });

  it("prefers Authorization over the vendor header fallbacks", () => {
    expect(
      getProvidedApiToken(
        makeReq({ authorization: "Bearer winner", "x-api-key": "loser" }),
      ),
    ).toBe("winner");
  });

  it("ignores a non-Bearer Authorization and uses x-api-key instead", () => {
    expect(
      getProvidedApiToken(
        makeReq({ authorization: "Token scheme", "x-api-key": "key-1" }),
      ),
    ).toBe("key-1");
  });

  it("returns null when no token headers are present", () => {
    expect(getProvidedApiToken(makeReq({ host: "localhost:2138" }))).toBe(null);
  });
});

describe("readCookie", () => {
  const name = getSessionCookieName();

  it("reads the named cookie and URL-decodes its value", () => {
    const raw = `${name}=${encodeURIComponent("session id/42")}`;
    expect(readCookie(makeReq({ cookie: raw }), name)).toBe("session id/42");
  });

  it("returns null when the cookie header is missing", () => {
    expect(readCookie(makeReq({}), name)).toBe(null);
  });

  it("returns null when the named cookie has an empty value", () => {
    expect(readCookie(makeReq({ cookie: `${name}=; other=1` }), name)).toBe(
      null,
    );
  });

  it("treats a malformed percent-escape as an absent cookie", () => {
    expect(readCookie(makeReq({ cookie: `${name}=%zz` }), name)).toBe(null);
  });

  it("reads the first header when cookie is array-valued", () => {
    // Node can deliver duplicate cookie headers folded into an array; both
    // readers defend against that shape, so exercise it directly.
    const req = makeReq({});
    (req.headers as { cookie?: string | string[] }).cookie = [
      `${name}=one`,
      `${name}=two`,
    ];
    expect(readCookie(req, name)).toBe("one");
  });
});

describe("parseCookieHeader", () => {
  it("returns an empty map for a missing header", () => {
    expect(parseCookieHeader(null).size).toBe(0);
  });

  it("parses multiple pairs and drops invalid segments", () => {
    const cookies = parseCookieHeader("a=1; junk; b=2; c=");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("2");
    expect(cookies.has("junk")).toBe(false);
    expect(cookies.has("c")).toBe(false);
  });

  it("keeps the raw value when percent-decoding fails", () => {
    // Contrast with readCookie: the map-based parser degrades to the raw
    // bytes so other cookies on the same header survive.
    expect(parseCookieHeader("bad=%zz").get("bad")).toBe("%zz");
  });
});

describe("parseSessionCookie", () => {
  it("returns the session id from a multi-cookie header", () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=${encodeURIComponent(
      "sess-123",
    )}; ${CSRF_COOKIE_NAME}=csrf`;
    expect(parseSessionCookie(makeReq({ cookie: header }))).toBe("sess-123");
  });

  it("returns null when only unrelated cookies are present", () => {
    expect(parseSessionCookie(makeReq({ cookie: "theme=dark" }))).toBe(null);
  });

  it("returns null when the session cookie value is empty", () => {
    expect(
      parseSessionCookie(makeReq({ cookie: `${SESSION_COOKIE_NAME}=` })),
    ).toBe(null);
  });
});

describe("serializeSessionCookie / serializeCsrfCookie", () => {
  const session = {
    id: "sess-abc",
    csrfSecret: "secret-abc",
    expiresAt: 1_700_000_000_000,
  };

  it("emits HttpOnly SameSite=Lax with the requested Max-Age and drops Secure on loopback", () => {
    const cookie = serializeSessionCookie(
      { id: session.id, expiresAt: session.expiresAt },
      { env: {}, maxAgeMs: 43_200_000 },
    );
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=sess-abc`)).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure when the API binds off loopback", () => {
    const cookie = serializeSessionCookie(
      { id: session.id, expiresAt: session.expiresAt },
      { env: { ELIZA_API_BIND: "0.0.0.0" }, maxAgeMs: 60_000 },
    );
    expect(cookie).toContain("; Secure");
  });

  it("derives Max-Age from expiresAt when not overridden", () => {
    const cookie = serializeSessionCookie(
      { id: session.id, expiresAt: Date.now() + 3_600_000 },
      { env: {} },
    );
    expect(cookie).toMatch(/Max-Age=(3599|3600)/);
  });

  it("carries the derived CSRF token and stays readable to scripts", () => {
    const cookie = serializeCsrfCookie(session, { env: {}, maxAgeMs: 60_000 });
    expect(
      cookie.startsWith(`${CSRF_COOKIE_NAME}=${deriveCsrfToken(session)}`),
    ).toBe(true);
    expect(cookie).not.toContain("HttpOnly");
  });

  it("builds Max-Age=0 expiry cookies for logout; only the session one is HttpOnly", () => {
    const sessionExpiry = serializeSessionExpiryCookie({ env: {} });
    expect(sessionExpiry.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(sessionExpiry).toContain("Max-Age=0");
    expect(sessionExpiry).toContain("HttpOnly");

    const csrfExpiry = serializeCsrfExpiryCookie({ env: {} });
    expect(csrfExpiry.startsWith(`${CSRF_COOKIE_NAME}=;`)).toBe(true);
    expect(csrfExpiry).toContain("Max-Age=0");
    expect(csrfExpiry).not.toContain("HttpOnly");
  });
});

describe("deriveCsrfToken / verifyCsrfToken", () => {
  const session = { id: "sess-csrf", csrfSecret: "secret-csrf" };

  it("derives the same token until the secret rotates", () => {
    expect(deriveCsrfToken(session)).toBe(deriveCsrfToken(session));
    expect(deriveCsrfToken(session)).not.toBe(
      deriveCsrfToken({ ...session, csrfSecret: "rotated" }),
    );
  });

  it("verifies the derived token and fails closed otherwise", () => {
    const token = deriveCsrfToken(session);
    expect(verifyCsrfToken(session, token)).toBe(true);

    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(verifyCsrfToken(session, flipped)).toBe(false);
    expect(verifyCsrfToken(session, "")).toBe(false);
    expect(verifyCsrfToken(session, null)).toBe(false);
    expect(verifyCsrfToken(session, "short")).toBe(false);
  });
});

describe("assertPasswordStrong", () => {
  it("accepts a password meeting length and composition", () => {
    expect(() => assertPasswordStrong("correct-horse-42")).not.toThrow();
  });

  it("rejects a too-short password with reason too_short", () => {
    let caught: unknown;
    try {
      assertPasswordStrong("ab".padEnd(PASSWORD_MIN_LENGTH - 1, "x"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WeakPasswordError);
    expect((caught as WeakPasswordError).reason).toBe("too_short");
  });

  it("rejects a password without letters with reason missing_letter", () => {
    let caught: unknown;
    try {
      assertPasswordStrong("!".repeat(PASSWORD_MIN_LENGTH));
    } catch (error) {
      caught = error;
    }
    expect((caught as WeakPasswordError).reason).toBe("missing_letter");
  });

  it("rejects letters-only passwords with reason missing_digit_or_symbol", () => {
    let caught: unknown;
    try {
      assertPasswordStrong("abcdefghijkl");
    } catch (error) {
      caught = error;
    }
    expect((caught as WeakPasswordError).reason).toBe(
      "missing_digit_or_symbol",
    );
  });
});

describe("hashPassword / verifyPassword (real argon2id)", () => {
  it("produces an encoded argon2id hash that verifies against the plain password", async () => {
    const plain = "correct horse battery staple 42";
    const hash = await hashPassword(plain);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(plain, hash)).resolves.toBe(true);
  });

  it("rejects a wrong password without throwing", async () => {
    const hash = await hashPassword("correct horse battery staple 42");
    await expect(
      verifyPassword("wrong horse battery staple 42", hash),
    ).resolves.toBe(false);
  });

  it("mints a fresh salt per hash", async () => {
    const first = await hashPassword("salted password example 42");
    const second = await hashPassword("salted password example 42");
    expect(first).not.toBe(second);
  });
});

describe("redactMetadata", () => {
  it("redacts token-shaped strings and keeps shorter ones", () => {
    const metadata = {
      short: "ok-session",
      edge19: "a".repeat(19),
      edge20: "a".repeat(20),
      punctuated: "Ab0_-".repeat(4),
    };
    expect(redactMetadata(metadata)).toStrictEqual({
      short: "ok-session",
      edge19: "a".repeat(19),
      edge20: "<redacted>",
      punctuated: "<redacted>",
    });
  });

  it("passes numbers and booleans through unchanged", () => {
    expect(redactMetadata({ count: 3, enabled: true })).toStrictEqual({
      count: 3,
      enabled: true,
    });
  });
});

describe("getSensitiveLimiter", () => {
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    _resetSensitiveLimiters();
  });

  afterEach(() => {
    _resetSensitiveLimiters();
  });

  it("allows up to the configured maximum per window then denies", () => {
    const limiter = getSensitiveLimiter("test.coverage.max");
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      expect(limiter.consume("10.9.9.9", T0)).toBe(true);
    }
    expect(limiter.consume("10.9.9.9", T0)).toBe(false);
  });

  it("opens a fresh bucket once the window elapses", () => {
    const limiter = getSensitiveLimiter("test.coverage.window");
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      limiter.consume("10.9.9.9", T0);
    }
    expect(limiter.consume("10.9.9.9", T0 + 1)).toBe(false);
    expect(
      limiter.consume("10.9.9.9", T0 + SENSITIVE_RATE_LIMIT_WINDOW_MS),
    ).toBe(true);
  });

  it("keeps buckets independent per client ip", () => {
    const limiter = getSensitiveLimiter("test.coverage.ip");
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      limiter.consume("10.9.9.9", T0);
    }
    expect(limiter.consume("10.9.9.9", T0)).toBe(false);
    expect(limiter.consume("10.9.9.10", T0)).toBe(true);
  });

  it("keeps named limiters independent of each other", () => {
    const exhausted = getSensitiveLimiter("test.coverage.named-a");
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      exhausted.consume("10.9.9.9", T0);
    }
    expect(exhausted.consume("10.9.9.9", T0)).toBe(false);
    expect(
      getSensitiveLimiter("test.coverage.named-b").consume("10.9.9.9", T0),
    ).toBe(true);
  });

  it("hands out the same instance for a repeated name", () => {
    expect(getSensitiveLimiter("auth.bootstrap.exchange")).toBe(
      bootstrapExchangeLimiter,
    );
  });

  it("refuses to create an unnamed limiter", () => {
    expect(() => getSensitiveLimiter("   ")).toThrow(/name is required/);
  });

  it("_resetSensitiveLimiters clears every bucket", () => {
    const limiter = getSensitiveLimiter("test.coverage.reset");
    for (let i = 0; i < SENSITIVE_RATE_LIMIT_MAX; i++) {
      limiter.consume("10.9.9.9", T0);
    }
    expect(limiter.consume("10.9.9.9", T0)).toBe(false);
    _resetSensitiveLimiters();
    expect(limiter.consume("10.9.9.9", T0)).toBe(true);
  });
});

describe("ensureAuthSessionOrBootstrap", () => {
  const REMOTE_IP = "198.51.100.7";
  const remoteReq = () => makeReq({}, REMOTE_IP);

  beforeEach(() => {
    _resetAuthRateLimiter();
  });

  afterEach(() => {
    _resetAuthRateLimiter();
  });

  it("denies an unauthenticated request with 401 auth_required", () => {
    expect(ensureAuthSessionOrBootstrap(remoteReq())).toStrictEqual({
      kind: "denied",
      status: 401,
      reason: "auth_required",
    });
  });

  it("classifies a session cookie before any bearer token", () => {
    const headers = {
      cookie: `${getSessionCookieName()}=cookie-session-id`,
      authorization: "Bearer bearer-token",
    };
    expect(
      ensureAuthSessionOrBootstrap(makeReq(headers, REMOTE_IP)),
    ).toStrictEqual({
      kind: "session",
      sessionId: "cookie-session-id",
    });
  });

  it("classifies a bearer token as bootstrap exchange material", () => {
    expect(
      ensureAuthSessionOrBootstrap(
        makeReq({ authorization: "Bearer boot-tok" }, REMOTE_IP),
      ),
    ).toStrictEqual({
      kind: "bootstrap",
      token: "boot-tok",
      bearer: "boot-tok",
    });
  });

  it("escalates repeated denials to 429 and recovers after reset", () => {
    let saw429 = false;
    let denied401 = 0;
    for (let attempt = 0; attempt < 30 && !saw429; attempt++) {
      const result = ensureAuthSessionOrBootstrap(remoteReq());
      if (result.kind === "denied") {
        if (result.status === 401) denied401++;
        if (result.status === 429) saw429 = true;
      }
    }
    expect(denied401).toBeGreaterThanOrEqual(1);
    expect(saw429).toBe(true);

    _resetAuthRateLimiter();
    const after = ensureAuthSessionOrBootstrap(remoteReq());
    expect(after.kind === "denied" ? after.status : null).toBe(401);
  });
});

describe("ensureCompatApiAuthorized", () => {
  const GATE_ENV_KEYS = [
    "ELIZA_API_TOKEN",
    "ELIZA_API_AUTH_TOKEN",
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_DEV_AUTH_BYPASS",
    "ELIZA_CLOUD_PROVISIONED",
    "STEWARD_AGENT_TOKEN",
    "ELIZAOS_CLOUD_ENABLED",
    "ELIZAOS_CLOUD_API_KEY",
  ] as const;
  let savedEnv: Array<[string, string | undefined]>;

  const loopbackOwnerReq = () => makeReq({ host: "localhost:2138" });
  const remoteReq = (headers: http.IncomingHttpHeaders = {}) =>
    makeReq(
      { host: "localhost:2138", "x-forwarded-for": "203.0.113.9", ...headers },
      "203.0.113.9",
    );

  beforeEach(() => {
    _resetAuthRateLimiter();
    savedEnv = GATE_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of GATE_ENV_KEYS) delete process.env[key];
    Reflect.deleteProperty(globalThis, BOOT_CONFIG_STORE_KEY);
  });

  afterEach(() => {
    _resetAuthRateLimiter();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("authorizes a trusted same-machine caller without a configured token", () => {
    const { res, status } = fakeRes();
    expect(ensureCompatApiAuthorized(loopbackOwnerReq(), res)).toBe(true);
    expect(status()).toBe(200);
  });

  it("rejects a remote caller with 401 when no token is configured", () => {
    const { res, status } = fakeRes();
    expect(ensureCompatApiAuthorized(remoteReq(), res)).toBe(false);
    expect(status()).toBe(401);
  });

  it("authorizes a remote caller presenting the configured token", () => {
    process.env.ELIZA_API_TOKEN = "gate-secret-1";
    const { res, status } = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({ authorization: "Bearer gate-secret-1" }),
        res,
      ),
    ).toBe(true);
    expect(status()).toBe(200);
  });

  it("rejects a remote caller presenting a wrong token", () => {
    process.env.ELIZA_API_TOKEN = "gate-secret-1";
    const { res, status } = fakeRes();
    expect(
      ensureCompatApiAuthorized(
        remoteReq({ authorization: "Bearer not-the-secret" }),
        res,
      ),
    ).toBe(false);
    expect(status()).toBe(401);
  });
});

describe("isDevEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("recognizes development spellings case-insensitively", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDevEnvironment()).toBe(true);
    vi.stubEnv("NODE_ENV", " DEV ");
    expect(isDevEnvironment()).toBe(true);
  });

  it("is false outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevEnvironment()).toBe(false);
  });

  it("is false when NODE_ENV is empty", () => {
    vi.stubEnv("NODE_ENV", "");
    expect(isDevEnvironment()).toBe(false);
  });
});
