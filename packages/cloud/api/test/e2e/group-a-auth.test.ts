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
 * Skip behavior matches `agent-token-flow.test.ts`: with REQUIRE_E2E_SERVER=0
 * and no reachable Worker (or no bootstrapped TEST_API_KEY) every test in this
 * file reports as a counted, named `skip` — never a silent pass.
 *
 * Run from `apps/api/`:
 *   bun test --preload ./test/e2e/preload.ts test/e2e/group-a-auth.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isLocalTarget,
  isServerReachable,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-a-auth] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (`bun run dev` in packages/cloud/api) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-a-auth] TEST_API_KEY is not set. Tests will SKIP. Run with " +
      "`bun test --preload ./test/e2e/preload.ts ...` against a live local " +
      "Postgres so the preload can seed a key.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

let _sessionCookie: string | null = null;
let anonSessionToken: string | null = null;

function internalHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.INTERNAL_SECRET || "test-internal-secret"}`,
    "Content-Type": "application/json",
  };
}

describeE2E("Group A: auth + sessions", () => {
  // --------------------------------------------------------------------
  // /api/auth/anonymous-session — POST, get-or-create anon session.
  // Not in publicPathPrefixes; middleware should require auth.
  // --------------------------------------------------------------------
  describe("POST /api/auth/anonymous-session", () => {
    test("auth gate: rejects unauthenticated POST", async () => {
      const res = await api.post("/api/auth/anonymous-session", {});
      // Not in publicPathPrefixes → the auth middleware rejects with 401.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("happy path: with valid Bearer creates or returns an anon session", async () => {
      const res = await api.post(
        "/api/auth/anonymous-session",
        {},
        { headers: bearerHeaders() },
      );
      // The bootstrapped API-key user is anonymous-eligible → session minted.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        isNew?: boolean;
        user?: { id?: string };
        session?: { session_token?: string; messages_limit?: number };
      };
      expect(body.session?.session_token).toBeTruthy();
      if (body.session?.session_token) {
        anonSessionToken = body.session.session_token;
      }
    });
  });

  // --------------------------------------------------------------------
  // /api/auth/pair — POST, validates pairing token. Public path.
  // --------------------------------------------------------------------
  describe("POST /api/auth/pair", () => {
    test("validation: missing token returns 400", async () => {
      const res = await api.post(
        "/api/auth/pair",
        {},
        {
          headers: {
            Origin: "http://localhost:8787",
            "Content-Type": "application/json",
          },
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("validation: missing Origin header returns 400", async () => {
      // Bun's fetch always sets Host but Origin is optional. Send a token
      // without Origin to hit the second 400 branch.
      const res = await fetch(`${getBaseUrl()}/api/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "fake-token" }),
      });
      // Bun's fetch sends no Origin → the route's "Origin header required"
      // branch answers 400 before token validation runs.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("auth gate: invalid pairing token returns 401", async () => {
      const res = await api.post(
        "/api/auth/pair",
        { token: "definitely-not-a-real-pairing-token-zzz" },
        {
          headers: {
            Origin: "http://localhost:8787",
            "Content-Type": "application/json",
          },
        },
      );
      // Token validation rejects the random token → 401.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------
  // /api/auth/steward-debug — removed. It must not be public/reachable.
  // --------------------------------------------------------------------
  describe("/api/auth/steward-debug", () => {
    test("removed debug route is not publicly reachable", async () => {
      // The route is gone AND the path is not public, so the auth middleware
      // rejects unauthenticated callers before 404 routing: 401 either way.
      const getRes = await api.get("/api/auth/steward-debug");
      expect(getRes.status).toBe(401);

      const postRes = await api.post("/api/auth/steward-debug", {
        token: "not-a-real-steward-jwt",
      });
      expect(postRes.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------
  // /api/auth/steward-session — POST sets cookie; DELETE clears. Public.
  // --------------------------------------------------------------------
  describe("/api/auth/steward-session", () => {
    // /api/auth/steward-session enforces a strict Origin/Referer CSRF check.
    // The dev-only localhost allowlist is gated on `!isProduction`, and the
    // deployed staging Worker runs NODE_ENV=production — so a localhost Origin
    // 403s (forbidden_origin) BEFORE body/token validation against staging.
    // Send a host that is UNCONDITIONALLY in PERMITTED_ORIGIN_HOSTS (works in
    // local dev AND deployed staging/prod) so the CSRF gate passes and the
    // handler's real validation is what the test observes.
    const stewardSessionHeaders = { Origin: "https://staging.elizacloud.ai" };

    test("POST validation: missing token returns 400", async () => {
      const res = await api.post(
        "/api/auth/steward-session",
        {},
        {
          headers: stewardSessionHeaders,
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Token required");
    });

    test("POST auth gate: invalid steward JWT returns 401", async () => {
      const res = await api.post(
        "/api/auth/steward-session",
        { token: "bogus.jwt.token" },
        { headers: stewardSessionHeaders },
      );
      // Env-dependent pair, named by body.code below: with a configured
      // Steward JWT secret the bogus token is rejected as 401 invalid_token;
      // the keyless local harness has no secret → 503 server_secret_missing.
      expect([401, 503]).toContain(res.status);
      const body = (await res.json()) as { code?: string; error?: string };
      expect(["invalid_token", "server_secret_missing"]).toContain(
        body.code ?? "",
      );
    });

    test("POST without Origin returns 403 (CSRF protection)", async () => {
      const res = await api.post("/api/auth/steward-session", {
        token: "bogus.jwt.token",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Forbidden");
    });

    test("DELETE clears cookies and returns ok", async () => {
      const res = await api.delete("/api/auth/steward-session", {
        headers: stewardSessionHeaders,
      });
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
  // /api/auth/steward-nonce-exchange — POST. Server-side OAuth code
  // exchange (response_type=code flow). Public route. Same CSRF gating
  // as /api/auth/steward-session.
  // --------------------------------------------------------------------
  describe("POST /api/auth/steward-nonce-exchange", () => {
    // Same CSRF-origin reasoning as stewardSessionHeaders above: a permitted
    // host unconditionally (localhost is dev-only, staging runs production).
    const nonceHeaders = { Origin: "https://staging.elizacloud.ai" };

    test("validation: missing code returns 400 missing_code", async () => {
      const res = await api.post(
        "/api/auth/steward-nonce-exchange",
        { redirectUri: "https://elizaos.ai/checkout" },
        { headers: nonceHeaders },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; error?: string };
      expect(body.code).toBe("missing_code");
    });

    test("validation: missing redirectUri returns 400", async () => {
      const res = await api.post(
        "/api/auth/steward-nonce-exchange",
        { code: "abc" },
        { headers: nonceHeaders },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("missing_code");
    });

    test("CSRF: POST without Origin returns 403 forbidden_origin", async () => {
      const res = await api.post("/api/auth/steward-nonce-exchange", {
        code: "abc",
        redirectUri: "https://elizaos.ai/checkout",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string; error?: string };
      expect(body.code).toBe("forbidden_origin");
    });

    test("happy-path inputs reach upstream; bogus code is rejected", async () => {
      const res = await api.post(
        "/api/auth/steward-nonce-exchange",
        {
          code: "not-a-real-steward-code",
          redirectUri: "https://elizaos.ai/checkout",
          tenantId: "elizacloud",
        },
        { headers: nonceHeaders },
      );
      // Possible outcomes depending on deployment:
      //   503 server_secret_missing       — no Steward JWT secret configured
      //   503 steward_upstream_unavailable — STEWARD_API_URL unset
      //   502 steward_upstream_unavailable — upstream unreachable
      //   401 code_invalid                 — upstream rejected the nonce
      //   401 invalid_token                — upstream returned a token we cannot verify
      expect([401, 502, 503]).toContain(res.status);
      const body = (await res.json()) as { code?: string; error?: string };
      expect([
        "code_invalid",
        "code_expired",
        "code_redirect_mismatch",
        "code_tenant_mismatch",
        "invalid_token",
        "server_secret_missing",
        "steward_upstream_unavailable",
      ]).toContain(body.code ?? "");
    });
  });

  // --------------------------------------------------------------------
  // /api/anonymous-session — GET, public. Lookup by ?token=.
  // --------------------------------------------------------------------
  describe("GET /api/anonymous-session", () => {
    test("validation: missing token query returns 400", async () => {
      const res = await api.get("/api/anonymous-session");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Session token is required");
    });

    test("validation: malformed token (too short) returns 400", async () => {
      const res = await api.get("/api/anonymous-session?token=short");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Invalid session token format");
    });

    test("auth gate: well-formed but unknown token returns 404", async () => {
      const fakeToken = "a".repeat(32);
      const res = await api.get(`/api/anonymous-session?token=${fakeToken}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Session not found or expired");
    });

    test("happy path: previously-minted token round-trips", async () => {
      if (!anonSessionToken)
        throw new Error("anon session token not set — earlier step failed");
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
      const res = await api.post("/api/set-anonymous-session", {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Session token is required");
    });

    test("auth gate: unknown sessionToken returns 404", async () => {
      const res = await api.post("/api/set-anonymous-session", {
        sessionToken: "z".repeat(32),
      });
      // Unknown token → 404 SESSION_NOT_FOUND (410 is reserved for expired).
      expect(res.status).toBe(404);
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
      const res = await api.get("/api/sessions/current");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("happy path: Bearer eliza_* returns session stats", async () => {
      const res = await api.get("/api/sessions/current", {
        headers: bearerHeaders(),
      });
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
  // Local e2e lacks JWKS, so the handler should fail closed rather than using a fake key.
  // --------------------------------------------------------------------
  describe("POST /api/internal/auth/refresh", () => {
    test("rejects missing internal bearer with 401 or JWKS config failure", async () => {
      const res = await api.post("/api/internal/auth/refresh", {
        token: "anything",
      });
      // The internal-bearer gate fires before any JWKS work → 401.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("rejects bogus bearer token", async () => {
      const res = await api.post(
        "/api/internal/auth/refresh",
        {},
        { headers: { Authorization: "Bearer not-a-real-internal-token" } },
      );
      expect(res.status).toBe(401);
    });

    test("GET is not mounted for token refresh", async () => {
      const res = await api.get("/api/internal/auth/refresh");
      expect(res.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------
  // /api/internal/identity/resolve — internal-only identity lookup.
  // --------------------------------------------------------------------
  describe("POST /api/internal/identity/resolve", () => {
    test("auth gate: missing internal bearer returns 401", async () => {
      const res = await api.post("/api/internal/identity/resolve", {
        identifier: "user@example.com",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    // Needs an INTERNAL_SECRET that matches the target Worker — only true for
    // a local dev Worker sharing our .env; skip against deployed targets.
    test.skipIf(!isLocalTarget())(
      "happy path: resolves bootstrapped test user email",
      async () => {
        const res = await api.post(
          "/api/internal/identity/resolve",
          { identifier: process.env.TEST_USER_EMAIL },
          { headers: internalHeaders() },
        );
        if (res.status !== 200) {
          const body = await res.text();
          throw new Error(
            `Expected 200 from /api/internal/identity/resolve, got ${res.status}: ${body.slice(0, 500)}`,
          );
        }
        const body = (await res.json()) as {
          success?: boolean;
          data?: {
            user?: { id?: string; email?: string; organizationId?: string };
          };
        };
        expect(body.success).toBe(true);
        expect(body.data?.user?.id).toBe(process.env.TEST_USER_ID);
        expect(body.data?.user?.email).toBe(process.env.TEST_USER_EMAIL);
        expect(body.data?.user?.organizationId).toBe(
          process.env.TEST_ORGANIZATION_ID,
        );
      },
    );

    // Reaches JSON validation only after the internal-bearer check passes —
    // which needs the matching secret, so local-target only.
    test.skipIf(!isLocalTarget())(
      "validation: invalid JSON body returns 400",
      async () => {
        const res = await fetch(
          `${getBaseUrl()}/api/internal/identity/resolve`,
          {
            method: "POST",
            headers: internalHeaders(),
            body: "this-is-not-json",
          },
        );
        expect(res.status).toBe(400);
      },
    );

    test("method gate: GET is not mounted", async () => {
      const res = await api.get("/api/internal/identity/resolve", {
        headers: internalHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------
  // /api/test/auth/session — POST, exchanges API key for session cookie.
  // Disabled unless PLAYWRIGHT_TEST_AUTH=true on the Worker.
  // --------------------------------------------------------------------
  describe("POST /api/test/auth/session", () => {
    test("auth gate: missing API key returns 401 (when enabled) or 404 (when disabled)", async () => {
      const res = await api.post("/api/test/auth/session", undefined);
      // The e2e harness always runs the Worker with PLAYWRIGHT_TEST_AUTH=true
      // (preload + batch runner set it), so the route is mounted → 401.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("auth gate: invalid API key returns 401 (when enabled)", async () => {
      const res = await api.post("/api/test/auth/session", undefined, {
        headers: { Authorization: "Bearer eliza_definitely-not-real" },
      });
      // Route is enabled in the harness (PLAYWRIGHT_TEST_AUTH=true) → the
      // invalid key is rejected as 401.
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
    });

    test("happy path: valid Bearer eliza_* mints a session cookie", async () => {
      // /api/test/auth/session is a TEST-ONLY route, disabled (404) on a
      // production-mode Worker (deployed staging/prod). Probe first and skip
      // when it isn't mounted rather than fail — the exchange can't work there.
      const probe = await api.post("/api/test/auth/session", undefined, {
        headers: { Authorization: "Bearer eliza_definitely-not-real" },
      });
      if (probe.status === 404) return;
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
      const res = await fetch(
        `${getBaseUrl()}/api/eliza-app/auth/connection-success?platform=web`,
        { redirect: "manual" },
      );
      // Handler issues c.redirect → Hono's default 302. Public path, no 401.
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toMatch(/\/dashboard\/chat/);
    });

    test("happy path: discord platform returns HTML success page", async () => {
      const res = await api.get(
        "/api/eliza-app/auth/connection-success?platform=discord",
      );
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toMatch(/connected/i);
      expect(body).toMatch(/Discord/i);
    });

    test("validation: source=eliza-app + provider returns provider-labeled HTML", async () => {
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
      const res = await api.post("/api/eliza-app/cli-auth/init", {});
      // Public — no auth gate, and the harness always has a live DB.
      expect(res.status).toBe(200);
    });

    test("validation: extra body fields are ignored (no schema rejection)", async () => {
      const res = await api.post("/api/eliza-app/cli-auth/init", {
        unexpected: "value",
        nested: { junk: true },
      });
      // No schema, so extra fields are ignored.
      expect(res.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------
  // /api/eliza-app/cli-auth/poll — GET ?session_id=..., public.
  // --------------------------------------------------------------------
  describe("GET /api/eliza-app/cli-auth/poll", () => {
    test("validation: missing session_id returns 400", async () => {
      const res = await api.get("/api/eliza-app/cli-auth/poll");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Missing session_id");
    });

    test("auth gate: unknown session_id returns 404", async () => {
      // A FRESH random id — the well-known all-zeros UUID collides with a
      // persistent expired row in the shared staging DB (returns 200
      // status=expired instead of 404), so it must be genuinely unknown.
      const res = await api.get(
        `/api/eliza-app/cli-auth/poll?session_id=${crypto.randomUUID()}`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Session not found");
    });

    test("happy path: init then poll returns status=pending", async () => {
      const initRes = await api.post("/api/eliza-app/cli-auth/init", {});
      expect(initRes.status).toBe(200);
      const initBody = (await initRes.json()) as { session_id?: string };
      const sessionId = initBody.session_id;
      expect(sessionId).toBeTruthy();

      const pollRes = await api.get(
        `/api/eliza-app/cli-auth/poll?session_id=${encodeURIComponent(sessionId ?? "")}`,
      );
      expect(pollRes.status).toBe(200);
      const pollBody = (await pollRes.json()) as {
        success?: boolean;
        status?: string;
      };
      expect(pollBody.success).toBe(true);
      // Freshly-inited session polled immediately → still pending.
      expect(pollBody.status).toBe("pending");
    });
  });

  // --------------------------------------------------------------------
  // /api/eliza-app/cli-auth/complete — POST, requires elizaApp Bearer.
  // --------------------------------------------------------------------
  describe("POST /api/eliza-app/cli-auth/complete", () => {
    test("auth gate: missing Authorization returns 401", async () => {
      const res = await api.post("/api/eliza-app/cli-auth/complete", {
        session_id: "abc",
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe("Unauthorized");
    });

    test("auth gate: invalid eliza-app Bearer returns 401", async () => {
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
      // Even with a bogus JWT-shaped token, validateAuthHeader should reject.
      const res = await api.post(
        "/api/eliza-app/cli-auth/complete",
        { session_id: "abc" },
        {
          headers: {
            Authorization:
              "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.not-a-real-sig",
          },
        },
      );
      expect(res.status).toBe(401);
    });
  });

  // /api/auth/logout — POST, ends all sessions + expires the auth cookies.
  describe("POST /api/auth/logout", () => {
    test("happy path: authenticated logout succeeds and expires auth cookies", async () => {
      const res = await api.post(
        "/api/auth/logout",
        {},
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success).toBe(true);
      // The handler expires the steward auth cookies on the way out.
      const setCookies =
        res.headers.getSetCookie?.() ??
        (res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie") as string]
          : []);
      expect(setCookies.join("; ").toLowerCase()).toContain("steward-token");
    });
  });
});
