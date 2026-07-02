/**
 * Group H — Misc / chain / gallery / internal / orgs / invites / cron routes.
 *
 * Covers the 23 mounted routes assigned in `test/FANOUT.md` Group H. Each
 * route gets:
 *   1. Auth gate — request without credentials returns the documented status
 *      (401 for protected routes; for public-prefix routes that authenticate
 *      inside the handler, the handler's own error code).
 *   2. Happy path — with the appropriate credential (Bearer eliza_*, cron
 *      secret, etc.) the response is reachable past auth and matches the
 *      documented contract or migration fallback.
 *   3. Validation — malformed body / bad query / wrong shape returns the
 *      expected 400 (or the route's documented error status when the route
 *      validates differently).
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass. Provider-keyed happy paths are split
 * into keyless-deterministic and live variants gated on the provider secret
 * the Worker itself reads (shared env in the local lane).
 *
 * Run from `packages/cloud/api/`:
 *   bun test --preload ./test/e2e/preload.ts test/e2e/group-h-misc.test.ts
 */

import { describe, expect, test } from "bun:test";

import {
  api,
  bearerHeaders,
  cronHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isLocalTarget,
  isServerReachable,
  url,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-h-misc] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-h-misc] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

// Session cookie for session-only routes (crypto payment confirm).
let sessionCookie: string | null = null;
if (serverReachable && hasTestApiKey) {
  try {
    sessionCookie = await exchangeApiKeyForSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[group-h-misc] session exchange failed (session tests will SKIP): ${msg}`,
    );
  }
}
const testSession = test.skipIf(
  !serverReachable || !hasTestApiKey || sessionCookie === null,
);

// Provider-keyed splits — these envs are the exact secrets the Worker reads.
const alchemyConfigured = Boolean(process.env.ALCHEMY_API_KEY?.trim());
const birdeyeConfigured = Boolean(process.env.BIRDEYE_API_KEY?.trim());
const oxapayConfigured = Boolean(process.env.OXAPAY_MERCHANT_API_KEY?.trim());
const sendgridConfigured = Boolean(process.env.SENDGRID_API_KEY?.trim());

const VALID_ETH_ADDRESS = `0x${"0".repeat(40)}`;
const VALID_ETH_TX_HASH = `0x${"a".repeat(64)}`;
const VALID_UUID_A = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_B = "22222222-2222-4222-8222-222222222222";

function internalHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.INTERNAL_SECRET || "test-internal-secret"}`,
    "Content-Type": "application/json",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/chain/nfts/:chain/:address
// /api/v1/chain/transfers/:chain/:address
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — /api/v1/chain/nfts/:chain/:address", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get(
      `/api/v1/chain/nfts/ethereum/${VALID_ETH_ADDRESS}`,
    );
    expect(res.status).toBe(401);
  });

  // Split on ALCHEMY_API_KEY (the chain-data upstream's key): without it the
  // proxy's upstream call fails → exactly 502; with it the proxy must succeed.
  test.skipIf(alchemyConfigured)(
    "keyless: chain-data proxy answers 502 upstream-error, not 501",
    async () => {
      const res = await api.get(
        `/api/v1/chain/nfts/ethereum/${VALID_ETH_ADDRESS}`,
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(502);
    },
  );
  test.skipIf(!alchemyConfigured)(
    "live: chain-data proxy returns NFT data",
    async () => {
      const res = await api.get(
        `/api/v1/chain/nfts/ethereum/${VALID_ETH_ADDRESS}`,
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(200);
    },
  );

  test("validation: malformed address returns 400", async () => {
    const res = await api.get("/api/v1/chain/nfts/ethereum/not-an-address", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

describeE2E("Group H — /api/v1/chain/transfers/:chain/:address", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get(
      `/api/v1/chain/transfers/base/${VALID_ETH_ADDRESS}`,
    );
    expect(res.status).toBe(401);
  });

  test.skipIf(alchemyConfigured)(
    "keyless: chain-data proxy answers 502 upstream-error, not 501",
    async () => {
      const res = await api.get(
        `/api/v1/chain/transfers/base/${VALID_ETH_ADDRESS}`,
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(502);
    },
  );
  test.skipIf(!alchemyConfigured)(
    "live: chain-data proxy returns transfer data",
    async () => {
      const res = await api.get(
        `/api/v1/chain/transfers/base/${VALID_ETH_ADDRESS}`,
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(200);
    },
  );

  test("validation: malformed address returns 400", async () => {
    const res = await api.get("/api/v1/chain/transfers/base/garbage", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });

  test("validation: malformed direction returns 400", async () => {
    const res = await api.get(
      `/api/v1/chain/transfers/base/${VALID_ETH_ADDRESS}?direction=sideways`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/gallery family
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — GET /api/v1/gallery/explore", () => {
  // /api/v1/gallery is NOT in publicPathPrefixes — middleware will require
  // auth even though the handler itself is documented as "public". We assert
  // the actual middleware behavior.
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get("/api/v1/gallery/explore");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, returns { items: [] }-shaped response", async () => {
    const res = await api.get("/api/v1/gallery/explore?limit=5", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("validation: invalid limit still returns 200 (handler clamps non-finite to 20)", async () => {
    const res = await api.get("/api/v1/gallery/explore?limit=not-a-number", {
      headers: bearerHeaders(),
    });
    // The handler coerces non-finite limits to the default 20 — the
    // documented contract is a successful 200.
    expect(res.status).toBe(200);
  });
});

describeE2E("Group H — GET /api/v1/gallery/stats", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get("/api/v1/gallery/stats");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, returns numeric totals", async () => {
    const res = await api.get("/api/v1/gallery/stats", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalImages?: number;
      totalVideos?: number;
      totalSize?: number;
    };
    expect(typeof body.totalImages).toBe("number");
    expect(typeof body.totalVideos).toBe("number");
    expect(typeof body.totalSize).toBe("number");
  });

  test("validation: only GET supported; POST returns non-200", async () => {
    const res = await api.post(
      "/api/v1/gallery/stats",
      {},
      { headers: bearerHeaders() },
    );
    // Hono answers 404 for methods not mounted on the sub-app.
    expect(res.status).toBe(404);
  });
});

describeE2E("Group H — DELETE /api/v1/gallery/:id", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.delete("/api/v1/gallery/some-id");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, unknown id → 404 (handler reaches NotFoundError)", async () => {
    const res = await api.delete(
      "/api/v1/gallery/00000000-0000-0000-0000-000000000000",
      {
        headers: bearerHeaders(),
      },
    );
    // Unknown id → the handler's own NotFoundError.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("resource_not_found");
  });

  test("validation: GET (unsupported method) does not return 200", async () => {
    const res = await api.get("/api/v1/gallery/some-id", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/proxy/birdeye/* — 308 redirect to /api/v1/apis/birdeye/*
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — GET /api/v1/proxy/birdeye/*", () => {
  test("legacy mount redirects to /api/v1/apis/birdeye (308)", async () => {
    const res = await fetch(
      url("/api/v1/proxy/birdeye/defi/price?address=foo"),
      {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(res.status).toBe(308);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("/api/v1/apis/birdeye/");
  });

  test("auth gate: missing credentials → 401 (after redirect follow)", async () => {
    const res = await api.get("/api/v1/proxy/birdeye/defi/price?address=foo");
    expect(res.status).toBe(401);
  });

  // The e2e DB seeds no market-data pricing rows, so the priced proxy's cost
  // lookup misses BEFORE the BIRDEYE_API_KEY check → exactly 404
  // resource_not_found. With a key + seeded pricing the proxy must succeed.
  test.skipIf(birdeyeConfigured)(
    "keyless: priced proxy answers 404 resource_not_found (unseeded pricing)",
    async () => {
      const res = await api.get(
        "/api/v1/proxy/birdeye/defi/price?address=foo",
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("resource_not_found");
    },
  );
  test.skipIf(!birdeyeConfigured)(
    "live: priced proxy forwards to Birdeye",
    async () => {
      const res = await api.get(
        "/api/v1/proxy/birdeye/defi/price?address=foo",
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(200);
    },
  );

  test("validation: PATCH (unsupported) is not mounted → 404", async () => {
    const res = await api.patch(
      "/api/v1/proxy/birdeye/defi/price",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/apis/birdeye/* — canonical Birdeye proxy
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — GET /api/v1/apis/birdeye/*", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get("/api/v1/apis/birdeye/defi/price?address=foo");
    expect(res.status).toBe(401);
  });

  test.skipIf(birdeyeConfigured)(
    "keyless: priced proxy answers 404 resource_not_found (unseeded pricing)",
    async () => {
      const res = await api.get("/api/v1/apis/birdeye/defi/price?address=foo", {
        headers: bearerHeaders(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("resource_not_found");
    },
  );
  test.skipIf(!birdeyeConfigured)(
    "live: priced proxy forwards to Birdeye",
    async () => {
      const res = await api.get("/api/v1/apis/birdeye/defi/price?address=foo", {
        headers: bearerHeaders(),
      });
      expect(res.status).toBe(200);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/apis/dexscreener/* — DexScreener GET proxy (latest/* only)
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — GET /api/v1/apis/dexscreener/*", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get(
      "/api/v1/apis/dexscreener/latest/dex/search?q=SOL",
    );
    expect(res.status).toBe(401);
  });

  test("happy path: proxies the keyless public DexScreener upstream", async () => {
    const res = await api.get(
      "/api/v1/apis/dexscreener/latest/dex/search?q=SOL",
      { headers: bearerHeaders() },
    );
    // DexScreener needs no API key — the proxy must really forward and
    // return upstream JSON.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs?: unknown[] };
    expect(Array.isArray(body.pairs)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/cron/agent-billing — protected by CRON_SECRET (auth.ts public path)
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — POST /api/cron/agent-billing", () => {
  test("auth gate: missing cron secret → 401", async () => {
    const res = await api.post("/api/cron/agent-billing", {});
    // /api/cron is on the middleware public list; the handler's own
    // requireCronSecret rejects missing credentials with 401.
    expect(res.status).toBe(401);
  });

  test("happy path: with cron headers, returns success envelope", async () => {
    const res = await api.post(
      "/api/cron/agent-billing",
      {},
      { headers: cronHeaders() },
    );
    // The harness supplies CRON_SECRET to both this process and the Worker,
    // so the billing run must complete (even with zero billable sandboxes).
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: { sandboxesProcessed?: number };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data?.sandboxesProcessed).toBe("number");
  });

  test("validation: wrong bearer (not the cron secret) → 401", async () => {
    const res = await api.post(
      "/api/cron/agent-billing",
      {},
      { headers: { Authorization: "Bearer not-the-cron-secret" } },
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/crypto/payments/:id/confirm — session/owner-required
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — POST /api/crypto/payments/:id/confirm", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/crypto/payments/missing-id/confirm", {
      transactionHash: VALID_ETH_TX_HASH,
    });
    expect(res.status).toBe(401);
  });

  test("session-only route: Bearer eliza_* keys are rejected with 401", async () => {
    const res = await api.post(
      "/api/crypto/payments/00000000-0000-0000-0000-000000000000/confirm",
      { transactionHash: VALID_ETH_TX_HASH },
      { headers: bearerHeaders() },
    );
    // requireUserWithOrg is session-based; API keys never satisfy it.
    expect(res.status).toBe(401);
  });

  testSession(
    "happy path: with a session, unknown payment id → 404",
    async () => {
      if (!sessionCookie) throw new Error("session cookie missing");
      const res = await api.post(
        "/api/crypto/payments/00000000-0000-0000-0000-000000000000/confirm",
        { transactionHash: VALID_ETH_TX_HASH },
        {
          headers: {
            Cookie: sessionCookie,
            "Content-Type": "application/json",
          },
        },
      );
      // The payment lookup runs first; a well-formed unknown id → 404.
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Payment not found");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// /api/crypto/webhook — public (signed payload), HMAC-SHA512 verified
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — /api/crypto/webhook", () => {
  test("auth gate: POST without HMAC header → 401 (signature verification fails)", async () => {
    const res = await api.post("/api/crypto/webhook", {
      trackId: "1",
      status: "paid",
    });
    // /api/crypto/webhook is public in middleware. Without
    // OXAPAY_MERCHANT_API_KEY the handler answers 503 service-unavailable;
    // configured, a missing HMAC header is a 401.
    expect(res.status).toBe(oxapayConfigured ? 401 : 503);
  });

  test("happy path: GET probe returns documented JSON status", async () => {
    const res = await api.get("/api/crypto/webhook");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; message?: string };
    expect(body.status).toBe("ok");
  });

  test("validation: bogus HMAC header → 401", async () => {
    const res = await api.post(
      "/api/crypto/webhook",
      { trackId: "1", status: "paid" },
      { headers: { hmac: "deadbeef".repeat(16) } },
    );
    // Same split: unconfigured → 503 before verification; configured → the
    // bogus signature fails HMAC verification → 401.
    expect(res.status).toBe(oxapayConfigured ? 401 : 503);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/feedback — POST, public-by-middleware? No — not in public list
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — POST /api/feedback", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/feedback", { comment: "hi" });
    expect(res.status).toBe(401);
  });

  test("happy path: sends when SENDGRID_API_KEY is set, exact 503 otherwise", async () => {
    const res = await api.post(
      "/api/feedback",
      { name: "Test", email: "test@example.com", comment: "Hello world" },
      { headers: bearerHeaders() },
    );
    if (sendgridConfigured) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success?: boolean };
      expect(body.success).toBe(true);
    } else {
      expect(res.status).toBe(503);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("not configured");
    }
  });

  test("validation: missing comment → 400 (Zod parse error)", async () => {
    const res = await api.post(
      "/api/feedback",
      { name: "Test" },
      { headers: bearerHeaders() },
    );
    // The handler `parse()`s and lets Zod throw; failureResponse converts
    // the ZodError to exactly 400.
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/internal/discord/* — internal service endpoints used by the Discord
// gateway and webhook gateway. These are real Worker routes; 501 is never an
// acceptable result.
// ─────────────────────────────────────────────────────────────────────────
const internalDiscordRoutes: Array<{
  path: string;
  method: "GET" | "POST";
  validPath?: string;
  validBody?: unknown;
  invalidPath?: string;
  invalidBody?: unknown;
  okStatus: number;
}> = [
  {
    path: "/api/internal/discord/eliza-app/messages",
    method: "POST",
    validBody: {
      channelId: "channel-1",
      messageId: "message-1",
      content: "hello",
      sender: { id: "discord-user-1", username: "tester" },
    },
    invalidBody: {},
    okStatus: 200,
  },
  {
    path: "/api/internal/discord/events",
    method: "POST",
    validBody: {
      connection_id: VALID_UUID_A,
      organization_id: VALID_UUID_B,
      platform_connection_id: "platform-connection-1",
      event_type: "MESSAGE_UPDATE",
      event_id: "event-1",
      guild_id: "guild-1",
      channel_id: "channel-1",
      data: {},
      timestamp: new Date().toISOString(),
    },
    invalidBody: {},
    okStatus: 200,
  },
  {
    path: "/api/internal/discord/gateway/assignments",
    method: "GET",
    validPath:
      "/api/internal/discord/gateway/assignments?pod=gateway-1&current=1&max=1",
    invalidPath: "/api/internal/discord/gateway/assignments?pod=",
    okStatus: 200,
  },
  {
    path: "/api/internal/discord/gateway/failover",
    method: "POST",
    validBody: { claiming_pod: "gateway-1", dead_pod: "gateway-2" },
    invalidBody: { claiming_pod: "gateway-1" },
    // Fresh e2e DB: the dead pod holds no assignments → deterministic 200.
    okStatus: 200,
  },
  {
    path: "/api/internal/discord/gateway/heartbeat",
    method: "POST",
    validBody: {
      pod_name: "gateway-1",
      connection_ids: [],
      connection_stats: [],
    },
    invalidBody: { pod_name: "gateway-1", connection_ids: ["not-a-uuid"] },
    okStatus: 200,
  },
  {
    path: "/api/internal/discord/gateway/shutdown",
    method: "POST",
    validBody: { pod_name: "gateway-1" },
    invalidBody: { pod_name: "" },
    okStatus: 200,
  },
  {
    path: "/api/internal/discord/gateway/status",
    method: "GET",
    validPath: "/api/internal/discord/gateway/status?pod=gateway-1",
    invalidPath: "/api/internal/discord/gateway/status?pod=",
    okStatus: 200,
  },
];

for (const {
  path,
  method,
  validPath,
  validBody,
  invalidPath,
  invalidBody,
  okStatus,
} of internalDiscordRoutes) {
  describeE2E(`Group H — ${method} ${path}`, () => {
    test("auth gate: missing internal bearer → 401", async () => {
      const res =
        method === "GET" ? await api.get(path) : await api.post(path, {});
      expect(res.status).toBe(401);
    });

    // internalHeaders() must match the target Worker's INTERNAL_SECRET —
    // only guaranteed for a local dev Worker; skip against deployed targets.
    test.skipIf(!isLocalTarget())(
      "happy path: with INTERNAL_SECRET Bearer, handler is live",
      async () => {
        const res =
          method === "GET"
            ? await api.get(validPath ?? path, { headers: internalHeaders() })
            : await api.post(path, validBody ?? {}, {
                headers: internalHeaders(),
              });
        expect(res.status).toBe(okStatus);
      },
    );

    // Reaches input validation only after the internal-bearer check passes,
    // which needs the matching secret → local-target only.
    test.skipIf(!isLocalTarget())("validation: bad input → 400", async () => {
      const res =
        method === "GET"
          ? await api.get(invalidPath ?? `${path}?pod=`, {
              headers: internalHeaders(),
            })
          : await api.post(path, invalidBody ?? {}, {
              headers: internalHeaders(),
            });
      expect(res.status).toBe(400);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// /api/invites/accept — auth-required (not on public list)
// /api/invites/validate — public so invite landing pages can validate tokens before login.
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — POST /api/invites/accept", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/invites/accept", { token: "test-token" });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer + bogus token, handler reaches service (returns 4xx, not 401)", async () => {
    const res = await api.post(
      "/api/invites/accept",
      { token: `test-${Date.now()}` },
      { headers: bearerHeaders() },
    );
    // Bogus token → the service's own 400 (invalid invite).
    expect(res.status).toBe(400);
  });

  test("validation: missing token → 400", async () => {
    const res = await api.post(
      "/api/invites/accept",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });
});

describeE2E("Group H — GET /api/invites/validate", () => {
  test("public validation: missing credentials + bogus token returns valid false", async () => {
    const res = await api.get("/api/invites/validate?token=foo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid?: boolean; success?: boolean };
    expect(body.valid).toBe(false);
  });

  test("happy path: with Bearer + bogus token, returns { valid: false } envelope", async () => {
    const res = await api.get("/api/invites/validate?token=does-not-exist", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid?: boolean; success?: boolean };
    expect(body.valid).toBe(false);
  });

  test("validation: missing token → 400", async () => {
    const res = await api.get("/api/invites/validate", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/organizations/invites and /api/organizations/members
// ─────────────────────────────────────────────────────────────────────────
describeE2E("Group H — GET /api/organizations/invites", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get("/api/organizations/invites");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, owner/admin gets list; member → 403", async () => {
    const res = await api.get("/api/organizations/invites", {
      headers: bearerHeaders(),
    });
    // The bootstrapped key's user is an org admin → 200 with a list.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("validation: POST with missing email → 400", async () => {
    const res = await api.post(
      "/api/organizations/invites",
      { role: "member" },
      { headers: bearerHeaders() },
    );
    // Zod rejects the missing email before any role handling.
    expect(res.status).toBe(400);
  });
});

describeE2E("Group H — DELETE /api/organizations/invites/:inviteId", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.delete(
      "/api/organizations/invites/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, unknown invite id → 404", async () => {
    const res = await api.delete(
      "/api/organizations/invites/00000000-0000-0000-0000-000000000000",
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("validation: GET (unsupported method) is not mounted → 404", async () => {
    const res = await api.get(
      "/api/organizations/invites/00000000-0000-0000-0000-000000000000",
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

describeE2E("Group H — GET /api/organizations/members", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.get("/api/organizations/members");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, owner/admin gets list; member → 403", async () => {
    const res = await api.get("/api/organizations/members", {
      headers: bearerHeaders(),
    });
    // The bootstrapped key's user is an org admin → 200 with a list.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: unknown[];
      success?: boolean;
    };
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("validation: POST (unsupported method) is not mounted → 404", async () => {
    const res = await api.post(
      "/api/organizations/members",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

describeE2E("Group H — PATCH /api/organizations/members/:userId", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.patch(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      {
        role: "member",
      },
    );
    expect(res.status).toBe(401);
  });

  test("role updates are owner-only: the admin-but-not-owner key gets 403", async () => {
    const res = await api.patch(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      { role: "member" },
      { headers: bearerHeaders() },
    );
    // The bootstrapped key's user is an org ADMIN but not the OWNER; the
    // owner check runs before target lookup or body validation.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("owners");
  });

  test("owner gate also fires before body validation (missing role)", async () => {
    const res = await api.patch(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(403);
  });

  test("delete: unknown member id → 404", async () => {
    const res = await api.delete(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});
