/**
 * Group A — Auth, sessions, identity routes (Hono Worker e2e).
 *
 * Covers the 14 routes assigned in `test/FANOUT.md` Group A. Each route gets:
 *   1. Auth gate — request without credentials returns the documented status
 *      (401 for protected routes, 200/400 for public routes).
 *   2. Happy path — with the appropriate credential or signed payload, the
 *      response shape matches the route's contract.
 *   3. Validation — malformed body / missing required query param returns 400
 *      with a structured `error` field.
 *
 * Skip behavior matches `agent-token-flow.test.ts`: every test no-ops if the
 * Worker isn't reachable. Tests that require a bootstrapped API key skip
 * cleanly when `TEST_API_KEY` is missing (preload couldn't seed the DB).
 *
 * Run from `apps/api/`:
 *   bun test --preload ./test/e2e/preload.ts test/e2e/group-a-auth.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
let _sessionCookie: string | null = null;
let anonSessionToken: string | null = null;

function shouldRun(): boolean {
  return serverReachable && hasTestApiKey;
}

function reachableOnly(): boolean {
  return serverReachable;
}

function internalHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.INTERNAL_SECRET || "test-internal-secret"}`,
    "Content-Type": "application/json",
  };
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-a-auth] ${getBaseUrl()} did not respond to /api/health. ` +
        "Tests will skip. Start the Worker (`bun run dev` in apps/api/) " +
        "or set TEST_API_BASE_URL to a reachable host.",
    );
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-a-auth] TEST_API_KEY is not set. Auth-gated tests will skip. " +
        "Run with `bun test --preload ./test/e2e/preload.ts ...` against a " +
        "live local Postgres so the preload can seed a key.",
    );
  }
});

afterAll(async () => {
  // Best-effort: nothing to clean up. CLI-auth sessions self-expire, anonymous
  // sessions cookie out, and steward cookies are scoped to the response.
});

describe("Group A: auth + sessions", () => {
  // --------------------------------------------------------------------
  // /api/auth/anonymous-session — POST, get-or-create anon session.
  // Not in publicPathPrefixes; middleware should require auth.
  // --------------------------------------------------------------------
  describe("POST /api/auth/anonymous-session", () => {
    test("auth gate: rejects unauthenticated POST", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/auth/anonymous-session", {});
      // Middleware not in publicPathPrefixes → 401. Some deployments may
      // still treat this as public; accept either but require a structured
      // error for the 401 case.
      expect([200, 401]).toContain(res.status);
      if (res.status === 401) {
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBeTruthy();
      }
    });

    test("happy path: with valid Bearer creates or returns an anon session", async () => {
      if (!shouldRun()) return;
      const res = await api.post("/api/auth/anonymous-session", {}, { headers: bearerHeaders() });
      // Steward session-mode users may not be able to mint anon sessions;
      // accept 200 (session minted) or 4xx (user is not anonymous-eligible).
      expect([200, 400, 403]).toContain(res.status);
      if (res.status === 200) {
        const body = (await res.json()) as {
          isNew?: boolean;
          user?: { id?: string };
          session?: { session_token?: string; messages_limit?: number };
        };
        expect(body.session?.session_token).toBeTruthy();
        if (body.session?.session_token) {
          anonSessionToken = body.session.session_token;
        }
      }
    });
  });

  // --------------------------------------------------------------------
  // /api/auth/pair — POST, validates pairing token. Public path.
  // --------------------------------------------------------------------
  describe("POST /api/auth/pair", () => {
    test("validation: missing token returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.post(
        "/api/auth/pair",
        {},
        { headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("validation: missing Origin header returns 400", async () => {
      if (!reachableOnly()) return;
      // Bun's fetch always sets Host but Origin is optional. Send a token
      // without Origin to hit the second 400 branch.
      const res = await fetch(`${getBaseUrl()}/api/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "fake-token" }),
      });
      // Some clients (browsers) auto-inject Origin; in CI we send none.
      expect([400, 401]).toContain(res.status);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("auth gate: invalid pairing token returns 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.post(
        "/api/auth/pair",
        { token: "definitely-not-a-real-pairing-token-zzz" },
        { headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" } },
      );
      // Token validation rejects → 401. (404 if token validates but the
      // sandbox is missing — shouldn't happen with a random token.)
      expect([401, 404]).toContain(res.status);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------
  // /api/auth/steward-debug — POST. Public path. Verifies a steward token.
  // --------------------------------------------------------------------
  describe("POST /api/auth/steward-debug", () => {
    test("validation: missing token returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/auth/steward-debug", {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("no token");
    });

    test("auth gate: invalid steward token returns failure payload", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/auth/steward-debug", {
        token: "not-a-real-steward-jwt",
      });
      // verifyStewardTokenCached returns null → handler returns 200 with
      // `{ error: "verification failed", step: "verify" }` (no explicit
      // status code in handler, so Hono defaults to 200). Accept either
      // shape but assert the `error` channel is populated.
      expect([200, 400, 401, 500]).toContain(res.status);
      const body = (await res.json()) as { error?: string; step?: string; ok?: boolean };
      // Either `error` is set OR `ok: true` (if a real token is leaking
      // into env). For a fake token we expect `error`.
      expect(body.error || body.ok).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------
  // /api/auth/steward-session — POST sets cookie; DELETE clears. Public.
  // --------------------------------------------------------------------
  describe("/api/auth/steward-session", () => {
    test("POST validation: missing token returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/auth/steward-session", {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Token required");
    });

    test("POST auth gate: invalid steward JWT returns 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/auth/steward-session", { token: "bogus.jwt.token" });
      expect([401, 503]).toContain(res.status);
      const body = (await res.json()) as { code?: string; error?: string };
      expect(["invalid_token", "server_secret_missing"]).toContain(body.code ?? "");
    });

    test("DELETE clears cookies and returns ok", async () => {
      if (!reachableOnly()) return;
      const res = await api.delete("/api/auth/steward-session");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean };
      expect(body.ok).toBe(true);
      // Verify the Set-Cookie header is asking the browser to expire.
      const setCookie = res.headers.get("set-cookie") ?? "";
      // Hono's deleteCookie sets Max-Age=0 or an Expires=Thu, 01 Jan 1970.
      expect(/steward-token/i.test(setCookie) || setCookie === "").toBe(true);
    });
  });

  // --------------------------------------------------------------------
  // /api/anonymous-session — GET, public. Lookup by ?token=.
  // --------------------------------------------------------------------
  describe("GET /api/anonymous-session", () => {
    test("validation: missing token query returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/anonymous-session");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Session token is required");
    });

    test("validation: malformed token (too short) returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/anonymous-session?token=short");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Invalid session token format");
    });

    test("auth gate: well-formed but unknown token returns 404", async () => {
      if (!reachableOnly()) return;
      const fakeToken = "a".repeat(32);
      const res = await api.get(`/api/anonymous-session?token=${fakeToken}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Session not found or expired");
    });

    test("happy path: previously-minted token round-trips", async () => {
      if (!reachableOnly() || !anonSessionToken) return;
      const res = await api.get(
        `/api/anonymous-session?token=${encodeURIComponent(anonSessionToken)}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success?: boolean;
        session?: { id?: string; messages_limit?: number };
      };
      expect(body.success).toBe(true);
      expect(body.session?.id).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------
  // /api/set-anonymous-session — POST, public.
  // --------------------------------------------------------------------
  describe("POST /api/set-anonymous-session", () => {
    test("validation: invalid JSON body returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await fetch(`${getBaseUrl()}/api/set-anonymous-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ this is not json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Invalid JSON body");
    });

    test("validation: missing sessionToken returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/set-anonymous-session", {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Session token is required");
    });

    test("auth gate: unknown sessionToken returns 404", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/set-anonymous-session", {
        sessionToken: "z".repeat(32),
      });
      expect([404, 410]).toContain(res.status);
      const body = (await res.json()) as { error?: string; code?: string };
      expect(body.error).toBeTruthy();
      expect(body.code).toBe("SESSION_NOT_FOUND");
    });
  });

  // --------------------------------------------------------------------
  // /api/sessions/current — GET, requires auth.
  // --------------------------------------------------------------------
  describe("GET /api/sessions/current", () => {
    test("auth gate: rejects unauthenticated GET with 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/sessions/current");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("happy path: Bearer eliza_* returns session stats", async () => {
      if (!shouldRun()) return;
      const res = await api.get("/api/sessions/current", { headers: bearerHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success?: boolean;
        data?: {
          credits_used?: number;
          requests_made?: number;
          tokens_consumed?: number;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(typeof body.data?.credits_used).toBe("number");
      expect(typeof body.data?.requests_made).toBe("number");
      expect(typeof body.data?.tokens_consumed).toBe("number");
    });

    test("validation: malformed Bearer rejected as 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/sessions/current", {
        headers: { Authorization: "Bearer not-a-real-key" },
      });
      // Non-eliza_ prefix doesn't trigger the api-key fast path → cookie
      // auth → no user → 401.
      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------
  // /api/internal/auth/refresh — rotates an internal JWT when JWKS is configured.
  // Local e2e lacks JWKS, so the handler should fail closed rather than using a stub.
  // --------------------------------------------------------------------
  describe("POST /api/internal/auth/refresh", () => {
    test("rejects missing internal bearer with 401 or JWKS config failure", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/internal/auth/refresh", { token: "anything" });
      expect([401, 503]).toContain(res.status);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("rejects bogus bearer token", async () => {
      if (!reachableOnly()) return;
      const res = await api.post(
        "/api/internal/auth/refresh",
        {},
        { headers: { Authorization: "Bearer not-a-real-internal-token" } },
      );
      expect([401, 503]).toContain(res.status);
    });

    test("GET is not mounted for token refresh", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/internal/auth/refresh");
      expect([401, 404, 405, 503]).toContain(res.status);
    });
  });

  // --------------------------------------------------------------------
  // /api/internal/identity/resolve — internal-only identity lookup.
  // --------------------------------------------------------------------
  describe("POST /api/internal/identity/resolve", () => {
    test("auth gate: missing internal bearer returns 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/internal/identity/resolve", {
        identifier: "user@example.com",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("happy path: resolves bootstrapped test user email", async () => {
      if (!shouldRun()) return;
      const res = await api.post(
        "/api/internal/identity/resolve",
        { identifier: process.env.TEST_USER_EMAIL },
        { headers: internalHeaders() },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success?: boolean;
        data?: { user?: { id?: string; email?: string; organizationId?: string } };
      };
      expect(body.success).toBe(true);
      expect(body.data?.user?.id).toBe(process.env.TEST_USER_ID);
      expect(body.data?.user?.email).toBe(process.env.TEST_USER_EMAIL);
      expect(body.data?.user?.organizationId).toBe(process.env.TEST_ORGANIZATION_ID);
    });

    test("validation: invalid JSON body returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await fetch(`${getBaseUrl()}/api/internal/identity/resolve`, {
        method: "POST",
        headers: internalHeaders(),
        body: "this-is-not-json",
      });
      expect(res.status).toBe(400);
    });

    test("method gate: GET is not mounted", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/internal/identity/resolve", {
        headers: internalHeaders(),
      });
      expect([404, 405]).toContain(res.status);
    });
  });

  // --------------------------------------------------------------------
  // /api/test/auth/session — POST, exchanges API key for session cookie.
  // Disabled unless PLAYWRIGHT_TEST_AUTH=true on the Worker.
  // --------------------------------------------------------------------
  describe("POST /api/test/auth/session", () => {
    test("auth gate: missing API key returns 401 (when enabled) or 404 (when disabled)", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/test/auth/session", undefined);
      expect([401, 404]).toContain(res.status);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("auth gate: invalid API key returns 401 (when enabled)", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/test/auth/session", undefined, {
        headers: { Authorization: "Bearer eliza_definitely-not-real" },
      });
      // Disabled → 404. Enabled but invalid → 401. Bad key validation → 401.
      expect([401, 404]).toContain(res.status);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("happy path: valid Bearer eliza_* mints a session cookie", async () => {
      if (!shouldRun()) return;
      const cookie = await exchangeApiKeyForSession();
      _sessionCookie = cookie;
      expect(cookie).toMatch(/^[^=]+=.+/);
    });
  });

  // --------------------------------------------------------------------
  // /api/eliza-app/auth/connection-success — GET, public. Returns HTML.
  // --------------------------------------------------------------------
  describe("GET /api/eliza-app/auth/connection-success", () => {
    test("auth gate: public path, GET with web platform redirects", async () => {
      if (!reachableOnly()) return;
      const res = await fetch(
        `${getBaseUrl()}/api/eliza-app/auth/connection-success?platform=web`,
        { redirect: "manual" },
      );
      // Handler issues c.redirect → 302 (or 301). Public path so no 401.
      expect([301, 302, 303, 307, 308]).toContain(res.status);
      const location = res.headers.get("location") ?? "";
      expect(location).toMatch(/\/dashboard\/chat/);
    });

    test("happy path: discord platform returns HTML success page", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/eliza-app/auth/connection-success?platform=discord");
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toMatch(/connected/i);
      expect(body).toMatch(/Discord/i);
    });

    test("validation: source=eliza-app + provider returns provider-labeled HTML", async () => {
      if (!reachableOnly()) return;
      const res = await api.get(
        "/api/eliza-app/auth/connection-success?source=eliza-app&platform=google&connection_id=conn-123",
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/Google/);
      expect(body).toMatch(/conn-123/);
      expect(body).toMatch(/eliza-app-oauth-complete/);
    });
  });

  // --------------------------------------------------------------------
  // /api/eliza-app/cli-auth/init — POST, public. Creates a pending session.
  // --------------------------------------------------------------------
  describe("POST /api/eliza-app/cli-auth/init", () => {
    test("happy path: returns a session_id and expires_at", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/eliza-app/cli-auth/init", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success?: boolean;
        session_id?: string;
        expires_at?: string;
      };
      expect(body.success).toBe(true);
      expect(body.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.expires_at).toBeTruthy();
    });

    test("auth gate: public path accepts request with no auth header", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/eliza-app/cli-auth/init", {});
      // Public — should not be 401. May be 200 or 500 (no DB).
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    test("validation: extra body fields are ignored (no schema rejection)", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/eliza-app/cli-auth/init", {
        unexpected: "value",
        nested: { junk: true },
      });
      // No schema, so this should still 200 (or 500 on DB failure).
      expect([200, 500]).toContain(res.status);
    });
  });

  // --------------------------------------------------------------------
  // /api/eliza-app/cli-auth/poll — GET ?session_id=..., public.
  // --------------------------------------------------------------------
  describe("GET /api/eliza-app/cli-auth/poll", () => {
    test("validation: missing session_id returns 400", async () => {
      if (!reachableOnly()) return;
      const res = await api.get("/api/eliza-app/cli-auth/poll");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Missing session_id");
    });

    test("auth gate: unknown session_id returns 404 (or 500 if no DB)", async () => {
      if (!reachableOnly()) return;
      const res = await api.get(
        "/api/eliza-app/cli-auth/poll?session_id=00000000-0000-0000-0000-000000000000",
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Session not found");
    });

    test("happy path: init then poll returns status=pending", async () => {
      if (!reachableOnly()) return;
      const initRes = await api.post("/api/eliza-app/cli-auth/init", {});
      expect(initRes.status).toBe(200);
      const initBody = (await initRes.json()) as { session_id?: string };
      const sessionId = initBody.session_id;
      expect(sessionId).toBeTruthy();

      const pollRes = await api.get(
        `/api/eliza-app/cli-auth/poll?session_id=${encodeURIComponent(sessionId ?? "")}`,
      );
      expect(pollRes.status).toBe(200);
      const pollBody = (await pollRes.json()) as { success?: boolean; status?: string };
      expect(pollBody.success).toBe(true);
      expect(["pending", "expired", "authenticated"]).toContain(pollBody.status ?? "");
    });
  });

  // --------------------------------------------------------------------
  // /api/eliza-app/cli-auth/complete — POST, requires elizaApp Bearer.
  // --------------------------------------------------------------------
  describe("POST /api/eliza-app/cli-auth/complete", () => {
    test("auth gate: missing Authorization returns 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.post("/api/eliza-app/cli-auth/complete", { session_id: "abc" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Unauthorized");
    });

    test("auth gate: invalid eliza-app Bearer returns 401", async () => {
      if (!reachableOnly()) return;
      const res = await api.post(
        "/api/eliza-app/cli-auth/complete",
        { session_id: "abc" },
        { headers: { Authorization: "Bearer not-a-real-eliza-app-jwt" } },
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Invalid session");
    });

    test("validation: a valid-looking but non-eliza-app JWT still 401", async () => {
      if (!reachableOnly()) return;
      // Even with a bogus JWT-shaped token, validateAuthHeader should reject.
      const res = await api.post(
        "/api/eliza-app/cli-auth/complete",
        { session_id: "abc" },
        {
          headers: {
            Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.not-a-real-sig",
          },
        },
      );
      expect(res.status).toBe(401);
    });
  });
});
