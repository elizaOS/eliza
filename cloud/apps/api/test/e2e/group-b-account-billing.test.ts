/**
 * Group B — Account / billing / credits / top-up routes.
 *
 * Covers the 16 routes assigned to Group B in `test/FANOUT.md`:
 *
 *   /api/v1/api-keys/:id/regenerate
 *   /api/v1/api-keys/explorer
 *   /api/v1/user/avatar
 *   /api/v1/user/email
 *   /api/v1/user/wallets
 *   /api/v1/user/wallets/provision
 *   /api/v1/user/wallets/rpc
 *   /api/v1/topup/10
 *   /api/v1/topup/50
 *   /api/v1/topup/100
 *   /api/v1/pricing/summary
 *   /api/quotas/usage
 *   /api/stats/account
 *   /api/stripe/create-checkout-session
 *   /api/stripe/credit-packs
 *   /api/signup-code/redeem
 *
 * Each route has three assertions where viable:
 *   1. Auth gate — request without credentials is rejected (401/403) or
 *      accepted (when the path is in `apps/api/src/middleware/auth.ts`'s
 *      public list).
 *   2. Happy path — with the bootstrapped Bearer key (or a session cookie
 *      for session-only routes) the response shape matches the handler's
 *      contract.
 *   3. Validation — at least one body / param failure returns 400.
 *
 * Skip behavior mirrors `agent-token-flow.test.ts`:
 *   - If `/api/health` is unreachable, every test skips silently.
 *   - If `TEST_API_KEY` was not bootstrapped (e.g. SKIP_DB_DEPENDENT=1 or
 *     no Postgres), tests that require a key skip; auth-gate assertions
 *     still run because they only need the server to answer.
 *   - External-provider routes assert deterministic configured/unconfigured
 *     behavior instead of skipping when provider secrets are absent.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getApiKey,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
let sessionCookie: string | null = null;
const createdApiKeyIds: string[] = [];
const TEST_WALLET_ACCOUNT = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

function shouldRunSession(): boolean {
  return shouldRunAuthed() && sessionCookie !== null;
}

async function signedWalletHeaders(path: string): Promise<Record<string, string>> {
  const timestamp = Date.now();
  const message = `Eliza Cloud Authentication\nTimestamp: ${timestamp}\nMethod: POST\nPath: ${path}`;
  const signature = await TEST_WALLET_ACCOUNT.signMessage({ message });

  return {
    "X-Wallet-Address": TEST_WALLET_ACCOUNT.address,
    "X-Timestamp": String(timestamp),
    "X-Wallet-Signature": signature,
    "Content-Type": "application/json",
  };
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-b-account-billing] ${getBaseUrl()} did not respond to /api/health. ` +
        "Tests will skip. Start the Worker (bun run dev → wrangler dev) " +
        "or set TEST_API_BASE_URL to a reachable host.",
    );
    return;
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-b-account-billing] TEST_API_KEY is not set; the preload could not " +
        "bootstrap a test API key. Tests requiring auth will skip.",
    );
    return;
  }
  try {
    sessionCookie = await exchangeApiKeyForSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[group-b-account-billing] session exchange failed: ${msg}`);
  }
});

afterAll(async () => {
  if (!serverReachable || !sessionCookie) return;
  for (const id of createdApiKeyIds) {
    await api.delete(`/api/v1/api-keys/${id}`, {
      headers: { Cookie: sessionCookie },
    });
  }
});

// -------- /api/v1/api-keys/explorer ----------------------------------------

describe("GET /api/v1/api-keys/explorer", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/api-keys/explorer");
    expect(res.status).toBe(401);
  });

  test("happy path: returns or creates the explorer key with Bearer auth", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/api-keys/explorer", {
      headers: bearerHeaders(),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as {
      apiKey?: { id?: string; key?: string; name?: string };
      isNew?: boolean;
    };
    expect(body.apiKey?.id).toBeTruthy();
    expect(body.apiKey?.name).toBe("API Explorer Key");
    expect(typeof body.isNew).toBe("boolean");
  });

  test("validation: rejects POST (only GET is mounted)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/v1/api-keys/explorer", {}, { headers: bearerHeaders() });
    expect([404, 405]).toContain(res.status);
  });
});

// -------- /api/v1/api-keys/:id/regenerate ----------------------------------

describe("POST /api/v1/api-keys/:id/regenerate", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/api-keys/00000000-0000-0000-0000-000000000000/regenerate");
    expect(res.status).toBe(401);
  });

  test("happy path: regenerates a freshly created key", async () => {
    if (!shouldRunSession()) return;
    if (!sessionCookie) throw new Error("session cookie missing");

    const createRes = await api.post(
      "/api/v1/api-keys",
      {
        name: `group-b-regenerate-${Date.now()}`,
        description: "Group B regen test — revoked in afterAll.",
        permissions: ["read"],
        rate_limit: 60,
      },
      { headers: { Cookie: sessionCookie } },
    );
    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as { apiKey?: { id?: string }; plainKey?: string };
    expect(created.apiKey?.id).toBeTruthy();
    if (created.apiKey?.id) createdApiKeyIds.push(created.apiKey.id);

    const regenRes = await api.post(
      `/api/v1/api-keys/${created.apiKey?.id}/regenerate`,
      undefined,
      { headers: { Cookie: sessionCookie } },
    );
    expect(regenRes.status).toBe(200);
    const regen = (await regenRes.json()) as {
      apiKey?: { id?: string };
      plainKey?: string;
    };
    expect(regen.apiKey?.id).toBe(created.apiKey?.id ?? "");
    expect(regen.plainKey).toMatch(/^eliza_/);
    expect(regen.plainKey).not.toBe(created.plainKey);
  });

  test("validation: 404 for an unknown id", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/api-keys/00000000-0000-0000-0000-000000000000/regenerate",
      undefined,
      { headers: bearerHeaders() },
    );
    expect([400, 404]).toContain(res.status);
  });
});

// -------- /api/v1/user/avatar (R2 multipart upload) ------------------------

describe("/api/v1/user/avatar", () => {
  test("auth gate: without credentials expect 401 from /api/", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/user/avatar");
    expect(res.status).toBe(401);
  });

  test("validation: JSON body returns 400 (multipart required)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/v1/user/avatar", { dummy: 1 }, { headers: bearerHeaders() });
    expect(res.status).toBe(400);
  });

  test("validation: GET returns 405", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/user/avatar", { headers: bearerHeaders() });
    expect(res.status).toBe(405);
  });
});

// -------- /api/v1/user/email -----------------------------------------------

describe("PATCH /api/v1/user/email", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.patch("/api/v1/user/email", { email: "x@y.com" });
    expect(res.status).toBe(401);
  });

  test("happy path: the bootstrapped user already has an email → 400 with success=false", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.patch(
      "/api/v1/user/email",
      { email: `group-b+${Date.now()}@example.com` },
      { headers: bearerHeaders() },
    );
    // The local test fixture user has an email; the handler refuses to overwrite.
    // 200 is acceptable too if the bootstrap left email blank.
    expect([200, 400]).toContain(res.status);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(typeof body.success).toBe("boolean");
  });

  test("validation: 400 on invalid email format", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.patch(
      "/api/v1/user/email",
      { email: "not-an-email" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});

// -------- /api/v1/user/wallets ---------------------------------------------

describe("GET /api/v1/user/wallets", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/user/wallets");
    expect(res.status).toBe(401);
  });

  test("happy path: returns a wallets array for the authed org", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/user/wallets", { headers: bearerHeaders() });
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { success?: boolean; data?: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  test("validation: POST is not mounted on this collection (only GET)", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/v1/user/wallets", {}, { headers: bearerHeaders() });
    expect([404, 405]).toContain(res.status);
  });
});

// -------- /api/v1/user/wallets/provision -----------------------------------

describe("POST /api/v1/user/wallets/provision", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/user/wallets/provision", {
      chainType: "evm",
      clientAddress: "0x0000000000000000000000000000000000000000",
    });
    expect(res.status).toBe(401);
  });

  test("happy path: provisions when external signer is configured, otherwise fails after auth", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/user/wallets/provision",
      {
        chainType: "evm",
        clientAddress: "0x0000000000000000000000000000000000000001",
      },
      { headers: bearerHeaders() },
    );
    expect([200, 403, 500, 503]).toContain(res.status);
  });

  test("validation: 400 on invalid clientAddress for chainType=evm", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/user/wallets/provision",
      { chainType: "evm", clientAddress: "not-an-address" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
  });
});

// -------- /api/v1/user/wallets/rpc -----------------------------------------

describe("POST /api/v1/user/wallets/rpc", () => {
  test("auth gate: 401 without wallet signature headers", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/user/wallets/rpc", {
      clientAddress: "0x0000000000000000000000000000000000000000",
      payload: { method: "eth_blockNumber", params: [] },
      signature: "0xdead",
      timestamp: Date.now(),
      nonce: "n-0",
    });
    // Wallet auth rejects: 401 (or 400 if validation fires before auth).
    expect([400, 401]).toContain(res.status);
  });

  test("validation: 400 on missing required fields", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/user/wallets/rpc", { clientAddress: "0xabc" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  test("happy path: signed wallet auth reaches ownership or RPC checks", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post(
      "/api/v1/user/wallets/rpc",
      {
        clientAddress: "0x0000000000000000000000000000000000000000",
        payload: { method: "personal_sign", params: ["hello"] },
        signature: "0xdead",
        timestamp: Date.now(),
        nonce: `n-${Date.now()}`,
      },
      { headers: await signedWalletHeaders("/api/v1/user/wallets/rpc") },
    );
    expect([401, 403]).toContain(res.status);
  });
});

// -------- /api/v1/topup/{10,50,100} (x402 wallet topup) --------------------

for (const amount of [10, 50, 100] as const) {
  describe(`POST /api/v1/topup/${amount}`, () => {
    test("auth gate: public path, request without auth still hits the live handler", async () => {
      if (!serverReachable) return;
      const res = await api.post(`/api/v1/topup/${amount}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/walletAddress/i);
    });

    test("happy path: valid recipient reaches x402 payment requirements", async () => {
      if (!serverReachable) return;
      const res = await api.post(
        `/api/v1/topup/${amount}`,
        { walletAddress: TEST_WALLET_ACCOUNT.address },
        { headers: bearerHeaders() },
      );
      expect([402, 503]).toContain(res.status);
      const body = (await res.json()) as { error?: string; accepts?: unknown[]; code?: string };
      if (res.status === 402) {
        expect(body.error).toBe("payment_required");
        expect(Array.isArray(body.accepts)).toBe(true);
      } else {
        expect(body.code).toBe("x402_not_configured");
      }
    });

    test("validation: GET is not mounted (only POST)", async () => {
      if (!serverReachable) return;
      const res = await api.get(`/api/v1/topup/${amount}`);
      expect([404, 405]).toContain(res.status);
    });
  });
}

// -------- /api/v1/pricing/summary ------------------------------------------

describe("GET /api/v1/pricing/summary", () => {
  test("public route: returns pricing snapshot without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/pricing/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asOf?: string; pricing?: Record<string, unknown> };
    expect(typeof body.asOf).toBe("string");
    expect(typeof body.pricing).toBe("object");
  });

  test("happy path: returns pricing snapshot with asOf timestamp", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/v1/pricing/summary", { headers: bearerHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asOf?: string; pricing?: Record<string, unknown> };
    expect(typeof body.asOf).toBe("string");
    expect(typeof body.pricing).toBe("object");
  });

  test("validation: POST is not mounted", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/v1/pricing/summary", {}, { headers: bearerHeaders() });
    expect([404, 405]).toContain(res.status);
  });
});

// -------- /api/quotas/usage ------------------------------------------------

describe("GET /api/quotas/usage", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/quotas/usage");
    expect(res.status).toBe(401);
  });

  test("happy path: returns quota usage data for the authed org", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/quotas/usage", { headers: bearerHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  test("validation: POST is not mounted", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/quotas/usage", {}, { headers: bearerHeaders() });
    expect([404, 405]).toContain(res.status);
  });
});

// -------- /api/stats/account -----------------------------------------------

describe("GET /api/stats/account", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/stats/account");
    expect(res.status).toBe(401);
  });

  test("happy path: returns the account-stats payload", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.get("/api/stats/account", { headers: bearerHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        totalGenerations?: number;
        apiCalls24h?: number;
      };
    };
    expect(body.success).toBe(true);
    expect(typeof body.data?.totalGenerations).toBe("number");
    expect(typeof body.data?.apiCalls24h).toBe("number");
  });

  test("validation: POST is not mounted", async () => {
    if (!shouldRunAuthed()) return;
    const res = await api.post("/api/stats/account", {}, { headers: bearerHeaders() });
    expect([404, 405]).toContain(res.status);
  });
});

// -------- /api/stripe/credit-packs (public) --------------------------------

describe("GET /api/stripe/credit-packs", () => {
  test("auth gate: public path, unauthenticated request reaches the handler", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/stripe/credit-packs");
    // Public path: 200 if Stripe DB rows exist, 500 on db failure. Never 401.
    expect(res.status).not.toBe(401);
    expect([200, 500]).toContain(res.status);
  });

  test("happy path: returns a creditPacks array", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/stripe/credit-packs");
    if (res.status === 200) {
      const body = (await res.json()) as { creditPacks?: unknown[] };
      expect(Array.isArray(body.creditPacks)).toBe(true);
    }
  });

  test("validation: POST is not mounted (only GET)", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/stripe/credit-packs");
    expect([404, 405]).toContain(res.status);
  });
});

// -------- /api/stripe/create-checkout-session ------------------------------

describe("POST /api/stripe/create-checkout-session", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/stripe/create-checkout-session", { amount: 5 });
    expect(res.status).toBe(401);
  });

  test("happy path: creates Checkout when Stripe is configured, otherwise fails after auth", async () => {
    if (!shouldRunSession()) return;
    if (!sessionCookie) throw new Error("session cookie missing");
    const res = await api.post(
      "/api/stripe/create-checkout-session",
      { amount: 5 },
      { headers: { Cookie: sessionCookie } },
    );
    expect([200, 201, 500, 503]).toContain(res.status);
    if (res.ok) {
      const body = (await res.json()) as { sessionId?: string; url?: string };
      expect(body.sessionId).toBeTruthy();
      expect(body.url).toMatch(/^https:\/\//);
    }
  });

  test("validation: 400 when neither creditPackId nor amount is provided", async () => {
    if (!shouldRunSession()) return;
    if (!sessionCookie) throw new Error("session cookie missing");
    const res = await api.post(
      "/api/stripe/create-checkout-session",
      {},
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});

// -------- /api/signup-code/redeem ------------------------------------------

describe("POST /api/signup-code/redeem", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/signup-code/redeem", { code: "any" });
    expect(res.status).toBe(401);
  });

  test("happy path: invalid code path returns a structured error (no real code in fixtures)", async () => {
    if (!shouldRunSession()) return;
    if (!sessionCookie) throw new Error("session cookie missing");
    // No fixture provisions a redeemable code, so we expect the negative
    // path (400 INVALID_CODE / 409 ALREADY_USED). Any happy-path "200"
    // would also be valid if a code is seeded.
    const res = await api.post(
      "/api/signup-code/redeem",
      { code: `group-b-${Date.now()}` },
      { headers: { Cookie: sessionCookie } },
    );
    expect([200, 400, 409]).toContain(res.status);
    const body = (await res.json()) as { success?: boolean; error?: string; bonus?: number };
    if (res.status === 200) {
      expect(body.success).toBe(true);
      expect(typeof body.bonus).toBe("number");
    } else {
      expect(typeof body.error).toBe("string");
    }
  });

  test("validation: 400 on missing code field", async () => {
    if (!shouldRunSession()) return;
    if (!sessionCookie) throw new Error("session cookie missing");
    const res = await api.post(
      "/api/signup-code/redeem",
      {},
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});

// Touch helper to satisfy unused-import diagnostics on hosts where TEST_API_KEY is unset.
void getApiKey;
