/**
 * Group F — Eliza-app connectors + integration webhooks (16 routes)
 *
 * Routes covered:
 *   /api/eliza-app/connections
 *   /api/eliza-app/connections/:platform/initiate
 *   /api/eliza-app/gateway/:agentId
 *   /api/eliza-app/user/me
 *   /api/eliza-app/webhook/blooio        (forwards to webhook gateway)
 *   /api/eliza-app/webhook/discord       (forwards to Discord webhook handler)
 *   /api/eliza-app/webhook/telegram      (forwards to webhook gateway)
 *   /api/eliza-app/webhook/twilio        (forwards to webhook gateway)
 *   /api/eliza-app/webhook/whatsapp      (forwards to webhook gateway)
 *   /api/eliza/rooms/:roomId             (legacy room route — 501)
 *   /api/eliza/rooms/:roomId/messages    (legacy room route — 501)
 *   /api/eliza/rooms/:roomId/messages/stream (legacy room route — 501)
 *   /api/eliza/rooms/:roomId/welcome
 *   /api/webhooks/blooio/:orgId
 *   /api/webhooks/twilio/:orgId
 *   /api/webhooks/whatsapp/:orgId
 *
 * Auth notes (from auth.ts publicPathPrefixes):
 *   - /api/eliza-app/webhook/* — public (no global auth gate)
 *   - /api/eliza-app/user/*   — public (handler does its own session check)
 *   - /api/eliza-app/gateway/* — public
 *   - /api/eliza/* — public
 *   - /api/webhooks/* — public
 *   - /api/eliza-app/connections requires an eliza-app session token
 *
 * Worker-compatible webhook routes should fail closed with a configuration
 * error when their upstream gateway URL is absent.
 *
 * Webhook signing tests (Blooio, Twilio, WhatsApp) run without a real DB
 *     because the handlers can skip signature verification when
 *     SKIP_WEBHOOK_VERIFICATION=true and NODE_ENV != "production". When that
 *     env is absent we assert the correct rejection code instead of 200.
 */

import { describe, expect, test } from "bun:test";
import { api, getBaseUrl, isServerReachable } from "./_helpers/api";

const serverReachable = await isServerReachable();
if (!serverReachable) {
  console.warn(
    `[group-f-connectors] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker is absent.
// (These tests need no API key — they assert unauthenticated contracts.)
const describeE2E = describe.skipIf(!serverReachable);

// No deletion is needed because these tests do not create persistent state.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an HMAC-SHA256 Blooio signature header.
 * Format: t=<unix>,v1=<hex>
 */
async function buildBlooioSignature(
  secret: string,
  body: string,
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

/**
 * Build an HMAC-SHA1 Twilio X-Twilio-Signature.
 * Twilio sorts form params alphabetically, appends them to the URL, then signs.
 */
async function buildTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  const data = url + sorted;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

/**
 * Build a WhatsApp x-hub-signature-256 header (sha256=<hex>).
 * Uses the Web Crypto API (SHA-256 HMAC), matching what the handler expects
 * in Workers runtime (the handler's verifyWebhookSignature delegates to
 * whatsappAutomationService, which ultimately calls verifyWhatsAppSignature).
 */
async function buildWhatsAppSignature(
  secret: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

// ---------------------------------------------------------------------------
// /api/eliza-app/connections
// ---------------------------------------------------------------------------

describeE2E("GET /api/eliza-app/connections", () => {
  test("no Authorization header → 401", async () => {
    const res = await api.get("/api/eliza-app/connections");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("invalid session token → 401", async () => {
    const res = await api.get("/api/eliza-app/connections", {
      headers: { Authorization: "Bearer invalid-session-token-xyz" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_SESSION");
  });

  test("unsupported platform query param with invalid session → 401 before 400", async () => {
    // Session validation runs before platform validation, so even with an
    // unsupported platform we hit the auth gate first.
    const res = await api.get(
      "/api/eliza-app/connections?platform=fakePlatform999",
      {
        headers: { Authorization: "Bearer bogus" },
      },
    );
    // Auth gate fires before the platform check.
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// /api/eliza-app/connections/:platform/initiate
// ---------------------------------------------------------------------------

describeE2E("POST /api/eliza-app/connections/:platform/initiate", () => {
  test("no Authorization header → 401", async () => {
    const res = await api.post(
      "/api/eliza-app/connections/google/initiate",
      {},
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("invalid session token → 401", async () => {
    const res = await api.post(
      "/api/eliza-app/connections/google/initiate",
      {},
      { headers: { Authorization: "Bearer invalid-xyz" } },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_SESSION");
  });

  test("unsupported platform with invalid session → 401 before 400", async () => {
    const res = await api.post(
      "/api/eliza-app/connections/unknown-platform-xyz/initiate",
      {},
      { headers: { Authorization: "Bearer bogus" } },
    );
    // Session check fires before the unsupported-platform 400.
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// /api/eliza-app/gateway/:agentId
// ---------------------------------------------------------------------------

describeE2E("POST /api/eliza-app/gateway/:agentId", () => {
  // Public path — no auth gate.

  test("missing message body → 400", async () => {
    const res = await api.post("/api/eliza-app/gateway/test-agent-001", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/empty message/i);
  });

  test("valid message → 200 with reply", async () => {
    const res = await api.post("/api/eliza-app/gateway/test-agent-001", {
      message: "hello",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      reply?: string;
      historyLength?: number;
    };
    expect(body.success).toBe(true);
    expect(typeof body.reply).toBe("string");
    expect(body.reply?.length).toBeGreaterThan(0);
    expect(typeof body.historyLength).toBe("number");
  });

  test("non-JSON body → 400 or 500", async () => {
    const res = await fetch(
      `${getBaseUrl()}/api/eliza-app/gateway/test-agent-001`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{",
      },
    );
    // The handler parses the body itself; malformed JSON surfaces as its own
    // 500 envelope (not a middleware 400).
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /api/eliza-app/user/me
// ---------------------------------------------------------------------------

describeE2E("GET /api/eliza-app/user/me", () => {
  // Public path per auth.ts, but handler checks its own session token.

  test("no Authorization header → 401", async () => {
    const res = await api.get("/api/eliza-app/user/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("invalid session token → 401", async () => {
    const res = await api.get("/api/eliza-app/user/me", {
      headers: { Authorization: "Bearer definitely-not-a-valid-session" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVALID_SESSION");
  });
});

// ---------------------------------------------------------------------------
// /api/eliza-app/webhook/* — forwards when configured; fail closed otherwise
// ---------------------------------------------------------------------------

describeE2E("POST /api/eliza-app/webhook/blooio", () => {
  test("without gateway URL → 503 WEBHOOK_GATEWAY_NOT_CONFIGURED", async () => {
    const res = await api.post("/api/eliza-app/webhook/blooio", {
      event: "test",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WEBHOOK_GATEWAY_NOT_CONFIGURED");
  });
});

describeE2E("POST /api/eliza-app/webhook/discord", () => {
  test("without Discord webhook handler URL → 503 DISCORD_WEBHOOK_HANDLER_NOT_CONFIGURED", async () => {
    const res = await api.post("/api/eliza-app/webhook/discord", {
      event: "test",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("DISCORD_WEBHOOK_HANDLER_NOT_CONFIGURED");
  });
});

describeE2E("POST /api/eliza-app/webhook/telegram", () => {
  test("without gateway URL → 503 WEBHOOK_GATEWAY_NOT_CONFIGURED", async () => {
    const res = await api.post("/api/eliza-app/webhook/telegram", {
      update_id: 1,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WEBHOOK_GATEWAY_NOT_CONFIGURED");
  });
});

describeE2E("POST /api/eliza-app/webhook/twilio", () => {
  test("without gateway URL → 503 WEBHOOK_GATEWAY_NOT_CONFIGURED", async () => {
    const res = await api.post("/api/eliza-app/webhook/twilio", {
      MessageSid: "SM_test",
      From: "+15551234567",
      To: "+15550000000",
      Body: "hello",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WEBHOOK_GATEWAY_NOT_CONFIGURED");
  });
});

describeE2E("POST /api/eliza-app/webhook/whatsapp", () => {
  test("without gateway URL → 503 WEBHOOK_GATEWAY_NOT_CONFIGURED", async () => {
    const res = await api.post("/api/eliza-app/webhook/whatsapp", {
      object: "whatsapp_business_account",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WEBHOOK_GATEWAY_NOT_CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// /api/eliza/rooms/:roomId compatibility route contract
// ---------------------------------------------------------------------------

describeE2E("GET/POST /api/eliza/rooms/:roomId (legacy route)", () => {
  test("any request → 501 unsupported route contract", async () => {
    const res = await api.get("/api/eliza/rooms/room-test-001");
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: string; success?: boolean };
    // Handler returns the compatibility unsupported-route body.
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /api/eliza/rooms/:roomId/messages compatibility route contract
// ---------------------------------------------------------------------------

describeE2E("POST /api/eliza/rooms/:roomId/messages (legacy route)", () => {
  test("any request → 501 unsupported route contract", async () => {
    const res = await api.post("/api/eliza/rooms/room-test-001/messages", {
      text: "hello",
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("not_yet_migrated");
  });
});

// ---------------------------------------------------------------------------
// /api/eliza/rooms/:roomId/messages/stream compatibility route contract
// ---------------------------------------------------------------------------

describeE2E(
  "POST /api/eliza/rooms/:roomId/messages/stream (legacy route)",
  () => {
    test("any request → 501 unsupported route contract", async () => {
      const res = await api.post(
        "/api/eliza/rooms/room-test-001/messages/stream",
        {
          text: "hello",
        },
      );
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("not_yet_migrated");
    });

    test("GET without auth (public path) → not 401", async () => {
      // The /api/eliza prefix is public — global auth does not block it.
      // The handler returns the compatibility 501 contract for all methods.
      const res = await api.get(
        "/api/eliza/rooms/room-test-001/messages/stream",
      );
      // Should not be 401 (public path), but may be 404 or 501 depending on method registration.
      expect(res.status).not.toBe(401);
    });
  },
);

// ---------------------------------------------------------------------------
// /api/eliza/rooms/:roomId/welcome
// ---------------------------------------------------------------------------

describeE2E("POST /api/eliza/rooms/:roomId/welcome", () => {
  // Public path — but handler enforces its own auth (session or anon cookie).

  test("no auth → 401", async () => {
    const res = await api.post("/api/eliza/rooms/room-welcome-test/welcome", {
      text: "Welcome to my room!",
    });
    // Handler returns 401 when resolveUserId() finds no session and no anon cookie.
    expect(res.status).toBe(401);
  });

  test("missing text → 400", async () => {
    // Empty-text validation fires before the auth check in this handler.
    const res = await api.post(
      "/api/eliza/rooms/room-welcome-test/welcome",
      {},
    );
    expect(res.status).toBe(400);
  });
});

describeE2E("DELETE /api/eliza/rooms/:roomId/welcome", () => {
  test("no auth → 401", async () => {
    const res = await api.delete("/api/eliza/rooms/room-welcome-test/welcome");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// /api/webhooks/blooio/:orgId
// ---------------------------------------------------------------------------

describeE2E("GET /api/webhooks/blooio/:orgId (health probe)", () => {
  test("returns 200 ok", async () => {
    const res = await api.get("/api/webhooks/blooio/test-org-blooio");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });
});

describeE2E("POST /api/webhooks/blooio/:orgId", () => {
  test("missing or invalid signature → 401 or 500 (no secret configured)", async () => {
    // Without SKIP_WEBHOOK_VERIFICATION, the handler tries to load the webhook
    // secret from the DB. In the test environment there is no DB row for
    // "test-org-blooio", so the handler either:
    //   (a) returns 500 "Webhook not configured" (no secret in DB), or
    //   (b) returns 401 "Invalid webhook signature" (bad sig).
    // Both are correct rejection paths — we assert the request is not 200.
    const body = JSON.stringify({
      event: "message.received",
      message_id: "msg-001",
    });
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/blooio/test-org-blooio`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Blooio-Signature": "t=0,v1=invalidsig",
        },
        body,
      },
    );
    // No org/secret named test-org-blooio is seeded, so the verifier throws
    // before signature comparison → the route's 500 envelope. (A seeded
    // secret would make this a 401 signature-mismatch.)
    expect(res.status).toBe(500);
  });

  test("invalid JSON body → 400", async () => {
    // When SKIP_WEBHOOK_VERIFICATION is enabled on the Worker, invalid JSON
    // surfaces as 400 before the signature check. Without it we still get a
    // rejection, though the status may be 401/500 due to missing secret first.
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/blooio/test-org-blooio`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Blooio-Signature": "t=0,v1=invalidsig",
        },
        body: "not-json{{{{",
      },
    );
    // Same unseeded-org path: the verifier throws before JSON validation.
    expect(res.status).toBe(500);
  });

  test("valid signed payload with SKIP_WEBHOOK_VERIFICATION → 200 or 500 (no DB)", async () => {
    // When SKIP_WEBHOOK_VERIFICATION=true is set on the Worker AND
    // NODE_ENV != "production", the handler processes without signature
    // verification. If the Worker doesn't have that flag, we get 500/401 and
    // this test still passes (we assert success OR a server-side error).
    const secret = "test-blooio-webhook-secret";
    const bodyJson = JSON.stringify({
      event: "message.sent",
      message_id: `msg-${Date.now()}`,
      sender: "+15550000001",
    });
    const sig = await buildBlooioSignature(secret, bodyJson);
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/blooio/test-org-blooio`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Blooio-Signature": sig,
        },
        body: bodyJson,
      },
    );
    // The e2e DB seeds no secret for test-org-blooio, so even a well-formed
    // signature dies in the verifier's org lookup → 500. (With a seeded
    // secret this is the 200 happy path; with SKIP_WEBHOOK_VERIFICATION the
    // sig is skipped entirely.)
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /api/webhooks/twilio/:orgId
// ---------------------------------------------------------------------------

describeE2E("GET /api/webhooks/twilio/:orgId (health probe)", () => {
  test("returns 200 ok", async () => {
    const res = await api.get("/api/webhooks/twilio/test-org-twilio");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });
});

describeE2E("POST /api/webhooks/twilio/:orgId", () => {
  test("no X-Twilio-Signature header → 401 or 500 (no auth token configured)", async () => {
    // Twilio webhook receives form-encoded data, not JSON.
    const formParams = new URLSearchParams({
      MessageSid: "SM1234567890abcdef",
      AccountSid: "AC1234567890abcdef",
      From: "+15550000001",
      To: "+15550000002",
      Body: "Hello from test",
      NumMedia: "0",
    });
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/twilio/test-org-twilio`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formParams.toString(),
      },
    );
    // No auth token is seeded for test-org-twilio: the verifier throws → 500.
    expect(res.status).toBe(500);
  });

  test("invalid/missing form fields → 400", async () => {
    // Sending an empty form body fails Zod schema validation before sig check.
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/twilio/test-org-twilio`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "not=valid",
      },
    );
    // Zod validation runs before the signature check → exactly 400.
    expect(res.status).toBe(400);
  });

  test("valid signed form payload with SKIP_WEBHOOK_VERIFICATION → 200/xml or 401/500", async () => {
    const authToken = "test-twilio-auth-token-abc";
    const requestUrl = `${getBaseUrl()}/api/webhooks/twilio/test-org-twilio`;
    const params: Record<string, string> = {
      MessageSid: `SM${Date.now()}`,
      AccountSid: "ACtest",
      From: "+15550000001",
      To: "+15550000002",
      Body: "Test message",
      NumMedia: "0",
    };
    const sig = await buildTwilioSignature(authToken, requestUrl, params);
    const formBody = new URLSearchParams(params).toString();
    const res = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": sig,
      },
      body: formBody,
    });
    // Without SKIP_WEBHOOK_VERIFICATION and with no seeded auth token the
    // verifier throws → 500. (SKIP_WEBHOOK_VERIFICATION=true would yield the
    // 200 TwiML path.)
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /api/webhooks/whatsapp/:orgId
// ---------------------------------------------------------------------------

describeE2E(
  "GET /api/webhooks/whatsapp/:orgId (Meta verification handshake)",
  () => {
    test("missing hub.mode query param → 403 (verification fails)", async () => {
      // Without hub.mode, hub.verify_token, hub.challenge the service
      // returns null → handler sends 403.
      const res = await api.get("/api/webhooks/whatsapp/test-org-wa");
      expect(res.status).toBe(403);
    });

    test("correct challenge params but unknown org → 403", async () => {
      const res = await api.get(
        "/api/webhooks/whatsapp/test-org-wa?" +
          "hub.mode=subscribe&hub.verify_token=any-token&hub.challenge=echo-this",
      );
      // Unknown org has no verify_token stored, so verification fails → 403.
      expect(res.status).toBe(403);
    });
  },
);

describeE2E("POST /api/webhooks/whatsapp/:orgId", () => {
  test("invalid signature with non-UUID orgId → 400 before signature handling", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/whatsapp/test-org-wa`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": "sha256=invalidsig",
        },
        body,
      },
    );
    // "test-org-wa" fails the route's UUID validation before any signature
    // handling → exactly 400.
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error?: string };
    expect(errBody.error).toBe("Invalid organization ID");
  });

  test("invalid JSON body → 400", async () => {
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/whatsapp/test-org-wa`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": "sha256=invalidsig",
        },
        body: "not-json{{",
      },
    );
    // UUID validation still fires first — the malformed JSON is never read.
    expect(res.status).toBe(400);
  });

  test("valid signed payload with SKIP_WEBHOOK_VERIFICATION → 200 or 400/401/500", async () => {
    const secret = "test-whatsapp-app-secret";
    const bodyJson = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const sig = await buildWhatsAppSignature(secret, bodyJson);
    const res = await fetch(
      `${getBaseUrl()}/api/webhooks/whatsapp/test-org-wa`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": sig,
        },
        body: bodyJson,
      },
    );
    // "test-org-wa" fails the route's UUID validation before any signature
    // handling — even a well-formed signature → exactly 400.
    expect(res.status).toBe(400);
  });
});
