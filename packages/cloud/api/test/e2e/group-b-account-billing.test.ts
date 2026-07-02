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
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass. Session-only tests additionally skip
 * loudly when the test-session exchange is unavailable. External-provider
 * routes assert deterministic configured/unconfigured behavior keyed on the
 * provider secret's presence in this env (shared with wrangler dev in the
 * local lane).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { buildWalletProvisionChallenge } from "@elizaos/cloud-sdk";
import { privateKeyToAccount } from "viem/accounts";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getApiKey,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-b-account-billing] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-b-account-billing] TEST_API_KEY is not set; the preload could " +
      "not bootstrap a test API key. Tests will SKIP.",
  );
}

let sessionCookie: string | null = null;
if (serverReachable && hasTestApiKey) {
  try {
    sessionCookie = await exchangeApiKeyForSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[group-b-account-billing] session exchange failed (session tests will SKIP): ${msg}`,
    );
  }
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);
// Session-only routes; loud skip when the test-session exchange is unavailable.
const testSession = test.skipIf(
  !serverReachable || !hasTestApiKey || sessionCookie === null,
);
// Live Steward provisioning is an explicit opt-in integration check.
const liveStewardWallet = process.env.RUN_STEWARD_WALLET_E2E === "1";
// Stripe checkout: deterministic keyless 503 vs live 200, keyed on the secret
// the Worker itself reads (shared env in the local lane).
const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY?.trim());

const createdApiKeyIds: string[] = [];
const TEST_WALLET_ACCOUNT = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);

async function signedWalletHeaders(
  path: string,
): Promise<Record<string, string>> {
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

/** A valid provision control-proof signed by `TEST_WALLET_ACCOUNT`. */
async function signedProvisionProof(
  clientAddress: string,
  chainType: "evm" | "solana",
): Promise<{ signature: string; timestamp: number; nonce: string }> {
  const timestamp = Date.now();
  const nonce = `prov-${timestamp}-${Math.trunc(timestamp / 7)}`;
  const signature = await TEST_WALLET_ACCOUNT.signMessage({
    message: buildWalletProvisionChallenge({
      clientAddress,
      chainType,
      timestamp,
      nonce,
    }),
  });
  return { signature, timestamp, nonce };
}

afterAll(async () => {
  if (!serverReachable || !sessionCookie) return;
  for (const id of createdApiKeyIds) {
    await api.delete(`/api/v1/api-keys/${id}`, {
      headers: { Cookie: sessionCookie },
    });
  }
});

// -------- /api/v1/api-keys/explorer ----------------------------------------

describeE2E("GET /api/v1/api-keys/explorer", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.get("/api/v1/api-keys/explorer");
    expect(res.status).toBe(401);
  });

  test("happy path: returns or creates the explorer key with Bearer auth", async () => {
    const res = await api.get("/api/v1/api-keys/explorer", {
      headers: bearerHeaders(),
    });
    // get-or-create: 201 exactly when the key was created (isNew), 200 when
    // it already existed — the pair must agree, anything else is a defect.
    const body = (await res.json()) as {
      apiKey?: { id?: string; key?: string; name?: string };
      isNew?: boolean;
    };
    expect(typeof body.isNew).toBe("boolean");
    expect(res.status).toBe(body.isNew ? 201 : 200);
    expect(body.apiKey?.id).toBeTruthy();
    expect(body.apiKey?.name).toBe("API Explorer Key");
  });

  test("validation: rejects POST (only GET is mounted)", async () => {
    const res = await api.post(
      "/api/v1/api-keys/explorer",
      {},
      { headers: bearerHeaders() },
    );
    // Hono answers 404 for methods that are not mounted on the sub-app.
    expect(res.status).toBe(404);
  });
});

// -------- /api/v1/api-keys/:id/regenerate ----------------------------------

describeE2E("POST /api/v1/api-keys/:id/regenerate", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post(
      "/api/v1/api-keys/00000000-0000-0000-0000-000000000000/regenerate",
    );
    expect(res.status).toBe(401);
  });

  testSession("happy path: regenerates a freshly created key", async () => {
    if (!sessionCookie) throw new Error("session cookie missing");

    const createRes = await api.post(
      "/api/v1/api-keys",
      {
        name: `group-b-regenerate-${Date.now()}`,
        description: "Group B regen test — revoked in afterAll.",
        rate_limit: 60,
      },
      { headers: { Cookie: sessionCookie } },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      apiKey?: { id?: string };
      plainKey?: string;
    };
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
    const res = await api.post(
      "/api/v1/api-keys/00000000-0000-0000-0000-000000000000/regenerate",
      undefined,
      { headers: bearerHeaders() },
    );
    // Well-formed UUID that misses the lookup → 404.
    expect(res.status).toBe(404);
  });
});

// -------- PATCH /api/v1/api-keys/:id (update) ------------------------------

describeE2E("PATCH /api/v1/api-keys/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.patch(
      "/api/v1/api-keys/00000000-0000-0000-0000-000000000000",
      { is_active: false },
    );
    expect(res.status).toBe(401);
  });

  testSession(
    "happy path: renames and disables a freshly created key",
    async () => {
      if (!sessionCookie) throw new Error("session cookie missing");

      const createRes = await api.post(
        "/api/v1/api-keys",
        {
          name: `group-b-patch-${Date.now()}`,
          description: "Group B patch test — revoked in afterAll.",
          rate_limit: 60,
        },
        { headers: { Cookie: sessionCookie } },
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { apiKey?: { id?: string } };
      expect(created.apiKey?.id).toBeTruthy();
      if (created.apiKey?.id) createdApiKeyIds.push(created.apiKey.id);

      const patchRes = await api.patch(
        `/api/v1/api-keys/${created.apiKey?.id}`,
        { name: "group-b-patched", is_active: false, rate_limit: 30 },
        { headers: { Cookie: sessionCookie } },
      );
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as {
        apiKey?: {
          id?: string;
          name?: string;
          is_active?: boolean;
          rate_limit?: number;
        };
      };
      expect(patched.apiKey?.id).toBe(created.apiKey?.id ?? "");
      expect(patched.apiKey?.name).toBe("group-b-patched");
      expect(patched.apiKey?.is_active).toBe(false);
      expect(patched.apiKey?.rate_limit).toBe(30);
    },
  );

  test("validation: 404 for an unknown id", async () => {
    const res = await api.patch(
      "/api/v1/api-keys/00000000-0000-0000-0000-000000000000",
      { is_active: false },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------- /api/v1/user/avatar (R2 multipart upload) ------------------------

describeE2E("/api/v1/user/avatar", () => {
  test("auth gate: without credentials expect 401 from /api/", async () => {
    const res = await api.post("/api/v1/user/avatar");
    expect(res.status).toBe(401);
  });

  test("validation: JSON body returns 400 (multipart required)", async () => {
    const res = await api.post(
      "/api/v1/user/avatar",
      { dummy: 1 },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("validation: GET returns 405", async () => {
    const res = await api.get("/api/v1/user/avatar", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(405);
  });
});

// -------- /api/v1/user/email -----------------------------------------------

describeE2E("PATCH /api/v1/user/email", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.patch("/api/v1/user/email", { email: "x@y.com" });
    expect(res.status).toBe(401);
  });

  test("happy path: the bootstrapped user already has an email → 400 with success=false", async () => {
    const res = await api.patch(
      "/api/v1/user/email",
      { email: `group-b+${Date.now()}@example.com` },
      { headers: bearerHeaders() },
    );
    // The preload's fixture user always carries an email; the handler
    // refuses to overwrite it → 400 with success=false.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  test("validation: 400 on invalid email format", async () => {
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

describeE2E("GET /api/v1/user/wallets", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.get("/api/v1/user/wallets");
    expect(res.status).toBe(401);
  });

  test("happy path: returns a wallets array for the authed org", async () => {
    const res = await api.get("/api/v1/user/wallets", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: unknown[];
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("validation: POST is not mounted on this collection (only GET)", async () => {
    const res = await api.post(
      "/api/v1/user/wallets",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------- /api/v1/user/wallets/provision -----------------------------------

describeE2E("POST /api/v1/user/wallets/provision", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post("/api/v1/user/wallets/provision", {
      chainType: "evm",
      clientAddress: "0x0000000000000000000000000000000000000000",
    });
    expect(res.status).toBe(401);
  });

  // Live Steward provisioning is an integration check, not a release smoke.
  // Loud, counted opt-in via RUN_STEWARD_WALLET_E2E=1.
  test.skipIf(!liveStewardWallet)(
    "happy path: provisions when external signer is configured, otherwise fails after auth",
    async () => {
      const clientAddress = TEST_WALLET_ACCOUNT.address;
      const res = await api.post(
        "/api/v1/user/wallets/provision",
        {
          chainType: "evm",
          clientAddress,
          controlProof: await signedProvisionProof(clientAddress, "evm"),
        },
        { headers: bearerHeaders() },
      );
      // Live-only (RUN_STEWARD_WALLET_E2E=1): the proof must be ACCEPTED — any
      // 400/401 means the signed challenge broke. Beyond that the status is
      // Steward's (200 provisioned; 403/500/503 downstream), named here because
      // the external service's failure modes are not this Worker's contract.
      expect([200, 403, 500, 503]).toContain(res.status);
    },
  );

  test("proof required: 400 when controlProof is absent", async () => {
    const res = await api.post(
      "/api/v1/user/wallets/provision",
      { chainType: "evm", clientAddress: TEST_WALLET_ACCOUNT.address },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
  });

  test("proof rejected: 401 when the proof is not signed by clientAddress", async () => {
    // clientAddress the caller does NOT control; proof signed by TEST_WALLET.
    const squattedAddress = "0x000000000000000000000000000000000000dEaD";
    const res = await api.post(
      "/api/v1/user/wallets/provision",
      {
        chainType: "evm",
        clientAddress: squattedAddress,
        controlProof: await signedProvisionProof(squattedAddress, "evm"),
      },
      { headers: bearerHeaders() },
    );
    // The signer (TEST_WALLET) != squattedAddress → signature fails to recover.
    expect(res.status).toBe(401);
  });

  test("validation: 400 on invalid clientAddress for chainType=evm", async () => {
    const res = await api.post(
      "/api/v1/user/wallets/provision",
      {
        chainType: "evm",
        clientAddress: "not-an-address",
        controlProof: await signedProvisionProof(
          "0x0000000000000000000000000000000000000001",
          "evm",
        ),
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Validation error");
  });
});

// -------- /api/v1/user/wallets/rpc -----------------------------------------

describeE2E("POST /api/v1/user/wallets/rpc", () => {
  test("auth gate: 401 without wallet signature headers", async () => {
    const res = await api.post("/api/v1/user/wallets/rpc", {
      clientAddress: "0x0000000000000000000000000000000000000000",
      payload: { method: "eth_blockNumber", params: [] },
      signature: "0xdead",
      timestamp: Date.now(),
      nonce: "n-0",
    });
    // Wallet auth runs before ownership/RPC handling and rejects the bogus
    // signature with 401 (the body itself is schema-valid).
    expect(res.status).toBe(401);
  });

  test("validation: 400 on missing required fields", async () => {
    const res = await api.post("/api/v1/user/wallets/rpc", {
      clientAddress: "0xabc",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  test("happy path: signed wallet auth reaches ownership or RPC checks", async () => {
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
    // The signature verifies, but TEST_WALLET is not a provisioned wallet for
    // any org → ownership check rejects with 401.
    expect(res.status).toBe(401);
  });
});

// -------- /api/v1/topup/{10,50,100} (x402 wallet topup) --------------------

for (const amount of [10, 50, 100] as const) {
  describeE2E(`POST /api/v1/topup/${amount}`, () => {
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
      // Env-keyed pair: 402 payment-required when x402 is configured on the
      // Worker, 503 x402_not_configured otherwise — the body discriminates.
      expect([402, 503]).toContain(res.status);
      const body = (await res.json()) as {
        error?: string;
        accepts?: unknown[];
        code?: string;
      };
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
      expect(res.status).toBe(404);
    });
  });
}

// -------- /api/v1/pricing/summary ------------------------------------------

describeE2E("GET /api/v1/pricing/summary", () => {
  test("public route: returns pricing snapshot without credentials", async () => {
    const res = await api.get("/api/v1/pricing/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      asOf?: string;
      pricing?: Record<string, unknown>;
    };
    expect(typeof body.asOf).toBe("string");
    expect(typeof body.pricing).toBe("object");
  });

  test("happy path: returns pricing snapshot with asOf timestamp", async () => {
    const res = await api.get("/api/v1/pricing/summary", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      asOf?: string;
      pricing?: Record<string, unknown>;
    };
    expect(typeof body.asOf).toBe("string");
    expect(typeof body.pricing).toBe("object");
  });

  test("validation: POST is not mounted", async () => {
    const res = await api.post(
      "/api/v1/pricing/summary",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------- /api/quotas/usage ------------------------------------------------

describeE2E("GET /api/quotas/usage", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.get("/api/quotas/usage");
    expect(res.status).toBe(401);
  });

  test("happy path: returns quota usage data for the authed org", async () => {
    const res = await api.get("/api/quotas/usage", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  test("validation: POST is not mounted", async () => {
    const res = await api.post(
      "/api/quotas/usage",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------- /api/stats/account -----------------------------------------------

describeE2E("GET /api/stats/account", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.get("/api/stats/account");
    expect(res.status).toBe(401);
  });

  test("happy path: returns the account-stats payload", async () => {
    const res = await api.get("/api/stats/account", {
      headers: bearerHeaders(),
    });
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
    const res = await api.post(
      "/api/stats/account",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------- /api/stripe/credit-packs (public) --------------------------------

describeE2E("GET /api/stripe/credit-packs", () => {
  test("auth gate: public path, unauthenticated request reaches the handler", async () => {
    const res = await api.get("/api/stripe/credit-packs");
    // Public path (never 401) serving DB-backed packs — a 500 is a defect,
    // not a tolerable state.
    expect(res.status).toBe(200);
  });

  test("happy path: returns a creditPacks array", async () => {
    const res = await api.get("/api/stripe/credit-packs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { creditPacks?: unknown[] };
    expect(Array.isArray(body.creditPacks)).toBe(true);
  });

  test("validation: POST is not mounted (only GET)", async () => {
    const res = await api.post("/api/stripe/credit-packs");
    expect(res.status).toBe(404);
  });
});

// -------- /api/stripe/create-checkout-session ------------------------------

describeE2E("POST /api/stripe/create-checkout-session", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post("/api/stripe/create-checkout-session", {
      amount: 5,
    });
    expect(res.status).toBe(401);
  });

  // Keyless-deterministic variant: without STRIPE_SECRET_KEY the handler
  // answers 503 service-unavailable after auth.
  test.skipIf(
    !serverReachable ||
      !hasTestApiKey ||
      sessionCookie === null ||
      stripeConfigured,
  )("keyless: checkout answers 503 when Stripe is not configured", async () => {
    if (!sessionCookie) throw new Error("session cookie missing");
    const res = await api.post(
      "/api/stripe/create-checkout-session",
      { amount: 5 },
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(503);
  });

  // Live variant: with Stripe configured the checkout must fully succeed.
  test.skipIf(
    !serverReachable ||
      !hasTestApiKey ||
      sessionCookie === null ||
      !stripeConfigured,
  )("live: creates a Checkout session with id + https url", async () => {
    if (!sessionCookie) throw new Error("session cookie missing");
    const res = await api.post(
      "/api/stripe/create-checkout-session",
      { amount: 5 },
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId?: string; url?: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.url).toMatch(/^https:\/\//);
  });

  testSession(
    "validation: 400 when neither creditPackId nor amount is provided",
    async () => {
      if (!sessionCookie) throw new Error("session cookie missing");
      const res = await api.post(
        "/api/stripe/create-checkout-session",
        {},
        { headers: { Cookie: sessionCookie } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
    },
  );
});

// -------- /api/signup-code/redeem ------------------------------------------

describeE2E("POST /api/signup-code/redeem", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post("/api/signup-code/redeem", { code: "any" });
    expect(res.status).toBe(401);
  });

  testSession(
    "happy path: invalid code path returns a structured error (no real code in fixtures)",
    async () => {
      if (!sessionCookie) throw new Error("session cookie missing");
      // No fixture seeds a redeemable code and the random code cannot exist,
      // so the contract is exactly the 400 INVALID_CODE negative path.
      const res = await api.post(
        "/api/signup-code/redeem",
        { code: `group-b-${Date.now()}` },
        { headers: { Cookie: sessionCookie } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(typeof body.error).toBe("string");
    },
  );

  testSession("validation: 400 on missing code field", async () => {
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
