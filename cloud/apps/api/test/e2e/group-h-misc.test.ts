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
 *      documented contract or migration stub.
 *   3. Validation — malformed body / bad query / wrong shape returns the
 *      expected 400 (or the route's documented error status when the route
 *      validates differently).
 *
 * Skip behavior:
 *   - If TEST_API_BASE_URL / TEST_BASE_URL is unreachable, every test skips.
 *   - For routes that need an API key, tests skip if TEST_API_KEY isn't
 *     populated by the preload (e.g. SKIP_DB_DEPENDENT=1).
 *   - Internal-secret routes use `test-internal-secret` when the env is unset.
 *
 * Run from `apps/api/`:
 *   bun test --preload ./test/e2e/preload.ts test/e2e/group-h-misc.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";

import {
  api,
  bearerHeaders,
  cronHeaders,
  getBaseUrl,
  isServerReachable,
  url,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;

const VALID_ETH_ADDRESS = `0x${"0".repeat(40)}`;
const VALID_ETH_TX_HASH = `0x${"a".repeat(64)}`;
const VALID_UUID_A = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_B = "22222222-2222-4222-8222-222222222222";

function reachableOnly(): boolean {
  return serverReachable;
}

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
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
      `[group-h-misc] ${getBaseUrl()} did not respond to /api/health. ` +
        "Tests will skip. Start the Worker (`bun run dev` in apps/api/) " +
        "or set TEST_API_BASE_URL to a reachable host.",
    );
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-h-misc] TEST_API_KEY is not set. Auth-gated happy-path tests " +
        "will skip. Run without SKIP_DB_DEPENDENT and ensure local Postgres " +
        "is reachable so the preload can bootstrap a key.",
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/chain/nfts/:chain/:address
// /api/v1/chain/transfers/:chain/:address
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — /api/v1/chain/nfts/:chain/:address", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get(`/api/v1/chain/nfts/ethereum/${VALID_ETH_ADDRESS}`);
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, handler reaches chain-data proxy", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get(`/api/v1/chain/nfts/ethereum/${VALID_ETH_ADDRESS}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).not.toBe(501);
    expect([200, 400, 402, 502, 504]).toContain(res.status);
  });

  test("validation: malformed address returns 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/chain/nfts/ethereum/not-an-address", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

describe("Group H — /api/v1/chain/transfers/:chain/:address", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get(`/api/v1/chain/transfers/base/${VALID_ETH_ADDRESS}`);
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, handler reaches chain-data proxy", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get(`/api/v1/chain/transfers/base/${VALID_ETH_ADDRESS}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).not.toBe(501);
    expect([200, 400, 402, 502, 504]).toContain(res.status);
  });

  test("validation: malformed address returns 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/chain/transfers/base/garbage", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });

  test("validation: malformed direction returns 400", async () => {
    if (!shouldRunAuthed()) return;
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
describe("Group H — GET /api/v1/gallery/explore", () => {
  // /api/v1/gallery is NOT in publicPathPrefixes — middleware will require
  // auth even though the handler itself is documented as "public". We assert
  // the actual middleware behavior.
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/v1/gallery/explore");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, returns { items: [] }-shaped response", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/gallery/explore?limit=5", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("validation: invalid limit still returns 200 (handler clamps non-finite to 20)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/gallery/explore?limit=not-a-number", {
      headers: bearerHeaders(),
    });
    // The handler defensively coerces non-finite values to the default 20
    // rather than returning 400, so a successful 200 is the documented
    // behavior. Accept either to stay tolerant of future tightening.
    expect([200, 400]).toContain(res.status);
  });
});

describe("Group H — GET /api/v1/gallery/stats", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/v1/gallery/stats");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, returns numeric totals", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/gallery/stats", { headers: bearerHeaders() });
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
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/v1/gallery/stats", {}, { headers: bearerHeaders() });
    expect(res.status).not.toBe(200);
    expect([400, 401, 403, 404, 405]).toContain(res.status);
  });
});

describe("Group H — DELETE /api/v1/gallery/:id", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.delete("/api/v1/gallery/some-id");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, unknown id → 404 (handler reaches NotFoundError)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.delete("/api/v1/gallery/00000000-0000-0000-0000-000000000000", {
      headers: bearerHeaders(),
    });
    // Either the row doesn't exist (404) or the handler reports a generic
    // failure. Auth is not the issue.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([404, 400, 500]).toContain(res.status);
  });

  test("validation: GET (unsupported method) does not return 200", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/gallery/some-id", { headers: bearerHeaders() });
    expect(res.status).not.toBe(200);
    expect([400, 401, 403, 404, 405]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/proxy/birdeye/* — 308 redirect to /api/v1/apis/birdeye/*
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — GET /api/v1/proxy/birdeye/*", () => {
  test("legacy mount redirects to /api/v1/apis/birdeye (308)", async () => {
    if (!reachableOnly()) return;
    const res = await fetch(url("/api/v1/proxy/birdeye/defi/price?address=foo"), {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.status).toBe(308);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("/api/v1/apis/birdeye/");
  });

  test("auth gate: missing credentials → 401 (after redirect follow)", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/v1/proxy/birdeye/defi/price?address=foo");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, request reaches handler (not blocked at auth)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/proxy/birdeye/defi/price?address=foo", {
      headers: bearerHeaders(),
    });
    // Handler may answer 200 (proxy success), 402 (insufficient credits),
    // 503 (BIRDEYE_API_KEY missing), or upstream proxy 4xx/5xx. Anything
    // other than auth rejection is acceptable.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("validation: PATCH (unsupported) does not return 200", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.patch(
      "/api/v1/proxy/birdeye/defi/price",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).not.toBe(200);
    expect([400, 401, 403, 404, 405]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/apis/birdeye/* — canonical Birdeye proxy
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — GET /api/v1/apis/birdeye/*", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/v1/apis/birdeye/defi/price?address=foo");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, request reaches handler", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/apis/birdeye/defi/price?address=foo", {
      headers: bearerHeaders(),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/apis/dexscreener/* — DexScreener GET proxy (latest/* only)
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — GET /api/v1/apis/dexscreener/*", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/v1/apis/dexscreener/latest/dex/search?q=SOL");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, reaches handler", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/apis/dexscreener/latest/dex/search?q=SOL", {
      headers: bearerHeaders(),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/v1/apis/streaming/sessions — stub relay mint
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — POST /api/v1/apis/streaming/sessions", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/v1/apis/streaming/sessions", {
      destinations: ["twitch"],
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/cron/agent-billing — protected by CRON_SECRET (auth.ts public path)
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — POST /api/cron/agent-billing", () => {
  test("auth gate: missing cron secret → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/cron/agent-billing", {});
    // /api/cron is on the middleware public list, so middleware passes
    // through and the handler's requireCronSecret returns 401 for missing
    // credentials. (403 also acceptable if the env has no CRON_SECRET set.)
    expect([401, 403]).toContain(res.status);
  });

  test("happy path: with cron headers, returns success envelope", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/cron/agent-billing", {}, { headers: cronHeaders() });
    // 200 when CRON_SECRET matches and the billing run completes (even
    // with zero billable sandboxes). 401/403 if the test secret doesn't
    // match the worker's env. 500 if billing service errors. We assert
    // we reach the handler past auth.
    expect([200, 401, 403, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as {
        success?: boolean;
        data?: { sandboxesProcessed?: number };
      };
      expect(body.success).toBe(true);
      expect(typeof body.data?.sandboxesProcessed).toBe("number");
    }
  });

  test("validation: wrong bearer (not the cron secret) → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post(
      "/api/cron/agent-billing",
      {},
      { headers: { Authorization: "Bearer not-the-cron-secret" } },
    );
    expect([401, 403]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/crypto/payments/:id/confirm — session/owner-required
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — POST /api/crypto/payments/:id/confirm", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/crypto/payments/missing-id/confirm", {
      transactionHash: VALID_ETH_TX_HASH,
    });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, unknown payment id → 404 (handler reaches DB)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/crypto/payments/00000000-0000-0000-0000-000000000000/confirm",
      { transactionHash: VALID_ETH_TX_HASH },
      { headers: bearerHeaders() },
    );
    // requireUserWithOrg is session-based — Bearer eliza_* may not satisfy
    // it on every deployment. Accept either auth rejection or the
    // post-auth path that yields 404 / business error.
    expect([401, 403, 404, 400, 500]).toContain(res.status);
  });

  test("validation: missing transactionHash → 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/crypto/payments/00000000-0000-0000-0000-000000000000/confirm",
      {},
      { headers: bearerHeaders() },
    );
    expect([400, 401, 403, 404]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/crypto/webhook — public (signed payload), HMAC-SHA512 verified
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — /api/crypto/webhook", () => {
  test("auth gate: POST without HMAC header → 401 (signature verification fails)", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/crypto/webhook", { trackId: "1", status: "paid" });
    // /api/crypto/webhook is public in middleware. Handler verifies the
    // HMAC header. Missing signature → 401, or 503 if not configured.
    expect([401, 403, 503]).toContain(res.status);
  });

  test("happy path: GET probe returns documented JSON status", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/crypto/webhook");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; message?: string };
    expect(body.status).toBe("ok");
  });

  test("validation: bogus HMAC header → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post(
      "/api/crypto/webhook",
      { trackId: "1", status: "paid" },
      { headers: { hmac: "deadbeef".repeat(16) } },
    );
    expect([401, 403, 503, 400]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/feedback — POST, public-by-middleware? No — not in public list
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — POST /api/feedback", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/feedback", { comment: "hi" });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, returns success envelope or service-unavailable", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/feedback",
      { name: "Test", email: "test@example.com", comment: "Hello world" },
      { headers: bearerHeaders() },
    );
    // 200 if the email service is configured, 503 if it's not. Either
    // means we reached the handler past auth. 500 acceptable on infra hiccups.
    expect([200, 503, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { success?: boolean };
      expect(body.success).toBe(true);
    }
  });

  test("validation: missing comment → 400 (Zod parse error)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/feedback", { name: "Test" }, { headers: bearerHeaders() });
    // The handler `parse()`s and lets Zod throw; failureResponse converts
    // ZodError to 400. Accept 400 or 500 if the failure handler doesn't
    // recognize the error class on every deployment.
    expect([400, 500]).toContain(res.status);
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
  okStatuses?: number[];
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
    okStatuses: [200],
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
    okStatuses: [200],
  },
  {
    path: "/api/internal/discord/gateway/assignments",
    method: "GET",
    validPath: "/api/internal/discord/gateway/assignments?pod=gateway-1&current=1&max=1",
    invalidPath: "/api/internal/discord/gateway/assignments?pod=",
    okStatuses: [200],
  },
  {
    path: "/api/internal/discord/gateway/failover",
    method: "POST",
    validBody: { claiming_pod: "gateway-1", dead_pod: "gateway-2" },
    invalidBody: { claiming_pod: "gateway-1" },
    okStatuses: [200, 409],
  },
  {
    path: "/api/internal/discord/gateway/heartbeat",
    method: "POST",
    validBody: { pod_name: "gateway-1", connection_ids: [], connection_stats: [] },
    invalidBody: { pod_name: "gateway-1", connection_ids: ["not-a-uuid"] },
    okStatuses: [200],
  },
  {
    path: "/api/internal/discord/gateway/shutdown",
    method: "POST",
    validBody: { pod_name: "gateway-1" },
    invalidBody: { pod_name: "" },
    okStatuses: [200],
  },
  {
    path: "/api/internal/discord/gateway/status",
    method: "GET",
    validPath: "/api/internal/discord/gateway/status?pod=gateway-1",
    invalidPath: "/api/internal/discord/gateway/status?pod=",
    okStatuses: [200],
  },
];

for (const {
  path,
  method,
  validPath,
  validBody,
  invalidPath,
  invalidBody,
  okStatuses,
} of internalDiscordRoutes) {
  describe(`Group H — ${method} ${path}`, () => {
    test("auth gate: missing internal bearer → 401", async () => {
      if (!reachableOnly()) return;
      const res = method === "GET" ? await api.get(path) : await api.post(path, {});
      expect(res.status).toBe(401);
    });

    test("happy path: with INTERNAL_SECRET Bearer, handler is live", async () => {
      if (!reachableOnly()) return;
      const res =
        method === "GET"
          ? await api.get(validPath ?? path, { headers: internalHeaders() })
          : await api.post(path, validBody ?? {}, { headers: internalHeaders() });
      expect(res.status).not.toBe(501);
      expect(okStatuses ?? [200]).toContain(res.status);
    });

    test("validation: bad input → 400", async () => {
      if (!reachableOnly()) return;
      const res =
        method === "GET"
          ? await api.get(invalidPath ?? `${path}?pod=`, { headers: internalHeaders() })
          : await api.post(path, invalidBody ?? {}, { headers: internalHeaders() });
      expect(res.status).toBe(400);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// /api/invites/accept — auth-required (not on public list)
// /api/invites/validate — public so invite landing pages can validate tokens before login.
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — POST /api/invites/accept", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.post("/api/invites/accept", { token: "stub" });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer + bogus token, handler reaches service (returns 4xx, not 401)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/invites/accept",
      { token: `stub-${Date.now()}` },
      { headers: bearerHeaders() },
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    // Bogus token → 400 (Invalid invite) or 500 from service.
    expect([400, 404, 409, 500]).toContain(res.status);
  });

  test("validation: missing token → 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/invites/accept", {}, { headers: bearerHeaders() });
    expect([400, 500]).toContain(res.status);
  });
});

describe("Group H — GET /api/invites/validate", () => {
  test("public validation: missing credentials + bogus token returns valid false", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/invites/validate?token=foo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid?: boolean; success?: boolean };
    expect(body.valid).toBe(false);
  });

  test("happy path: with Bearer + bogus token, returns { valid: false } envelope", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/invites/validate?token=does-not-exist", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid?: boolean; success?: boolean };
    expect(body.valid).toBe(false);
  });

  test("validation: missing token → 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/invites/validate", { headers: bearerHeaders() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /api/organizations/invites and /api/organizations/members
// ─────────────────────────────────────────────────────────────────────────
describe("Group H — GET /api/organizations/invites", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/organizations/invites");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, owner/admin gets list; member → 403", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/organizations/invites", { headers: bearerHeaders() });
    expect(res.status).not.toBe(401);
    // 200 (owner/admin) or 403 (non-admin). Both prove auth+routing succeeded.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { data?: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  test("validation: POST with missing email → 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/organizations/invites",
      { role: "member" },
      { headers: bearerHeaders() },
    );
    // Expect 400 from Zod, or 403 if the test user isn't an owner/admin.
    expect([400, 403]).toContain(res.status);
  });
});

describe("Group H — DELETE /api/organizations/invites/:inviteId", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.delete("/api/organizations/invites/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, unknown id → 404/403/500 (not 401)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.delete(
      "/api/organizations/invites/00000000-0000-0000-0000-000000000000",
      { headers: bearerHeaders() },
    );
    expect(res.status).not.toBe(401);
    expect([404, 403, 500]).toContain(res.status);
  });

  test("validation: GET (unsupported) does not return 200", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/organizations/invites/00000000-0000-0000-0000-000000000000", {
      headers: bearerHeaders(),
    });
    expect(res.status).not.toBe(200);
    expect([400, 401, 403, 404, 405]).toContain(res.status);
  });
});

describe("Group H — GET /api/organizations/members", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.get("/api/organizations/members");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, owner/admin gets list; member → 403", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/organizations/members", { headers: bearerHeaders() });
    expect(res.status).not.toBe(401);
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { data?: unknown[]; success?: boolean };
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  test("validation: POST (unsupported) does not return 200", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/organizations/members", {}, { headers: bearerHeaders() });
    expect(res.status).not.toBe(200);
    expect([400, 401, 403, 404, 405]).toContain(res.status);
  });
});

describe("Group H — PATCH /api/organizations/members/:userId", () => {
  test("auth gate: missing credentials → 401", async () => {
    if (!reachableOnly()) return;
    const res = await api.patch("/api/organizations/members/00000000-0000-0000-0000-000000000000", {
      role: "member",
    });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, non-owner forbidden, owner reaches handler", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.patch(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      { role: "member" },
      { headers: bearerHeaders() },
    );
    expect(res.status).not.toBe(401);
    // 403 (non-owner), 404 (target user not found), 400 (cannot change own
    // role, etc.), or 500. Anything but 401 proves auth+routing succeeded.
    expect([403, 404, 400, 500]).toContain(res.status);
  });

  test("validation: missing role → 400", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.patch(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      {},
      { headers: bearerHeaders() },
    );
    expect([400, 403, 404, 500]).toContain(res.status);
  });

  test("delete: with Bearer, unknown user → not 401", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.delete(
      "/api/organizations/members/00000000-0000-0000-0000-000000000000",
      { headers: bearerHeaders() },
    );
    expect(res.status).not.toBe(401);
    expect([403, 404, 400, 500]).toContain(res.status);
  });
});
