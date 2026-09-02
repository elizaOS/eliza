/**
 * Behavioral coverage for the global Cloud auth gate. Drives the real
 * `isPublicPath` / `isRouteAuthenticatedInferencePath` predicates and the
 * live `authMiddleware` through Hono — no session cookie means the real
 * `getCurrentUser` returns null, which is the 401 path under test.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

type AuditEmit = {
  action?: string;
  actor?: unknown;
  metadata?: unknown;
  ip?: string;
};

// This package's unit lane runs these files with `bun test`
// (packages/cloud/api/test/run-unit-isolated.mjs), and bun's vitest compat
// layer has no vi.hoisted -- verified against the pinned bun 1.3.14, where
// `typeof vi.mock` is "function" but `typeof vi.hoisted` is "undefined".
// Under vitest the file passed; under the lane that actually gates it, every
// case died at collection. So build the collaborator inside the mock factory
// and reach it afterwards through the mocked module, per #26087.
vi.mock("../services/audit-dispatcher-singleton", () => {
  const auditEmits: AuditEmit[] = [];
  const auditDispatcher = {
    emit: async (input: AuditEmit) => {
      auditEmits.push(input);
      return input;
    },
  };
  return {
    getAuditDispatcher: () => auditDispatcher,
    initAuditDispatcher: () => auditDispatcher,
    setAuditDispatcher: () => undefined,
    __auditEmits: auditEmits,
  };
});

const auditModule = (await import(
  "../services/audit-dispatcher-singleton"
)) as unknown as {
  __auditEmits: AuditEmit[];
};
const auditEmits = auditModule.__auditEmits;

const {
  authMiddleware,
  isPublicPath,
  isRouteAuthenticatedInferencePath,
  isRouteAuthenticatedPaidProxyPath,
  isRouteAuthenticatedRemoteHostRequest,
} = await import("./auth");

const REMOTE_HOST_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_REMOTE_HOST_ID = "40000000-0000-4000-8000-000000000002";
const REMOTE_HOST_TOKEN = `rhost_v1_${"A".repeat(43)}`;

function remoteHostRequest(pathname: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${REMOTE_HOST_TOKEN}`);
  }
  if (!headers.has("X-Remote-Host-Id")) {
    headers.set("X-Remote-Host-Id", REMOTE_HOST_ID);
  }
  return new Request(`http://localhost${pathname}`, {
    ...init,
    method: init.method ?? "POST",
    headers,
  });
}

const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/i18n/locale",
  "/api/og",
  "/api/openapi.json",
  "/api/eliza",
  "/api/fal/proxy",
  "/api/public",
  "/api/v1/apps-ingress/ask",
  "/api/v1/admin/docker-nodes/bootstrap-callback",
  "/api/auth/cli-session",
  "/api/v1/cli-auth",
  "/api/auth/siwe",
  "/api/auth/siws",
  "/api/auth/steward-session",
  "/api/auth/steward-nonce-exchange",
  "/api/auth/steward-refresh",
  "/api/auth/staging-session-exchange",
  "/api/auth/sso-bridge",
  "/api/auth/logout",
  "/api/oidc",
  "/api/set-anonymous-session",
  "/api/anonymous-session",
  "/api/auth/create-anonymous-session",
  "/api/affiliate",
  "/api/invites/validate",
  "/api/v1/generate-image",
  "/api/v1/generate-video",
  "/api/v1/chat",
  "/api/v1/messages",
  "/api/v1/responses",
  "/api/v1/embeddings",
  "/api/v1/models",
  "/api/v1/pricing/summary",
  "/api/v1/agents/by-token",
  "/api/v1/agent-tokens",
  "/api/v1/credits/topup",
  "/api/v1/topup",
  "/api/v1/x402",
  "/api/v1/market/preview",
  "/api/stripe/credit-packs",
  "/api/stripe/webhook",
  "/api/v1/stripe/webhook",
  "/api/v1/oxapay/webhook",
  "/api/crypto/webhook",
  "/api/crypto/status",
  "/api/crypto/direct-payments/config",
  "/api/cron",
  "/api/v1/cron",
  "/api/mcps",
  "/api/mcp/list",
  "/api/mcp",
  "/api/a2a",
  "/api/agents",
  "/api/v1/track",
  "/api/v1/discovery",
  "/api/v1/domains/resolve",
  "/api/v1/marketing/inventory/serve",
  "/api/v1/marketing/inventory/click",
  "/api/v1/advertising/conversions/track",
  "/api/v1/advertising/reports",
  "/api/v1/hosted-frontend/serve",
  "/api/v1/proxy/birdeye",
  "/api/v1/discord/callback",
  "/api/v1/twitter/callback",
  "/api/v1/voice/session/ws",
  "/api/v1/twilio/voice/inbound",
  "/api/v1/twilio/voice/media",
  "/api/v1/twilio/voice/status",
  "/api/v1/oauth/providers",
  "/api/v1/oauth/callback",
  "/api/v1/oauth/success-proof/verify",
  "/api/v1/user/wallets/rpc",
  "/api/v1/app-auth",
  "/api/.well-known",
  "/api/internal",
  "/api/webhooks",
  "/api/v1/telegram/webhook",
  "/api/v1/earnings/payout/stripe-connect/webhook",
  "/api/eliza-app/auth",
  "/api/eliza-app/connections",
  "/api/eliza-app/webhook",
  "/api/eliza-app/user",
  "/api/eliza-app/cli-auth",
  "/api/eliza-app/onboarding",
] as const;

const INFERENCE_PATHS = [
  "/api/v1/eliza/agents/agent-1/stream",
  "/api/v1/eliza/agents/agent-1/bridge",
  "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages",
  "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages/stream",
] as const;

async function dispatch(
  url: string,
  init: RequestInit = {},
  env: Record<string, string | undefined> = { NODE_ENV: "test" },
): Promise<Response> {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.all("*", (c) => c.json({ ok: true }));
  return app.request(url, init, env);
}

describe("isPublicPath — pairing and exact special cases", () => {
  test("keeps only the loopback browser relay public", () => {
    expect(isPublicPath("/api/auth/pair")).toBe(true);
    expect(isPublicPath("/api/auth/pair/")).toBe(true);
    expect(isPublicPath("/api/auth/pair/native")).toBe(false);
    expect(isPublicPath("/api/auth/pair/native/extra")).toBe(false);
  });

  test("treats the unsuffixed oauth callback as public", () => {
    expect(isPublicPath("/api/v1/oauth/callback")).toBe(true);
  });

  test("subscriptions/plans is public only for GET and HEAD", () => {
    expect(isPublicPath("/api/v1/subscriptions/plans")).toBe(true);
    expect(isPublicPath("/api/v1/subscriptions/plans/")).toBe(true);
    expect(isPublicPath("/api/v1/subscriptions/plans", "HEAD")).toBe(true);
    expect(isPublicPath("/api/v1/subscriptions/plans", "POST")).toBe(false);
    expect(isPublicPath("/api/v1/subscriptions/plans", "PUT")).toBe(false);
    expect(isPublicPath("/api/v1/subscriptions/plans/extra")).toBe(false);
  });

  test("success-proof verify is public with or without a trailing slash", () => {
    expect(isPublicPath("/api/v1/oauth/success-proof/verify")).toBe(true);
    expect(isPublicPath("/api/v1/oauth/success-proof/verify/")).toBe(true);
    // The prefix list also contains this path, so a child segment is public
    // via `startsWith(prefix + "/")` — same as every other prefix entry.
    expect(isPublicPath("/api/v1/oauth/success-proof/verify/extra")).toBe(true);
  });
});

describe("isPublicPath — regex special cases", () => {
  test("provider oauth callbacks are public, extra segments are not", () => {
    expect(isPublicPath("/api/v1/oauth/github/callback")).toBe(true);
    expect(isPublicPath("/api/v1/oauth/github/callback/")).toBe(true);
    expect(isPublicPath("/api/v1/oauth/github/callback/extra")).toBe(false);
    expect(isPublicPath("/api/v1/oauth//callback")).toBe(false);
  });

  test("app generate-image, public, and charge paths are public", () => {
    expect(isPublicPath("/api/v1/apps/app-1/generate-image")).toBe(true);
    expect(isPublicPath("/api/v1/apps/app-1/generate-image/")).toBe(true);
    expect(isPublicPath("/api/v1/apps/app-1/public")).toBe(true);
    expect(isPublicPath("/api/v1/apps/app-1/charges/chg-1")).toBe(true);
    expect(isPublicPath("/api/v1/apps/app-1/charges/chg-1/")).toBe(true);
    expect(isPublicPath("/api/v1/apps/app-1")).toBe(false);
    expect(isPublicPath("/api/v1/apps/app-1/charges")).toBe(false);
    expect(isPublicPath("/api/v1/apps/app-1/charges/chg-1/extra")).toBe(false);
  });

  test("character public pages are public; other character routes stay gated", () => {
    expect(isPublicPath("/api/characters/c-1/public")).toBe(true);
    expect(isPublicPath("/api/characters/c-1/public/")).toBe(true);
    expect(isPublicPath("/api/characters/c-1")).toBe(false);
    expect(isPublicPath("/api/characters/c-1/public/extra")).toBe(false);
  });
});

describe("isPublicPath — out-of-band token pages", () => {
  test("sensitive-request detail + submit are public", () => {
    expect(isPublicPath("/api/v1/sensitive-requests/req-1")).toBe(true);
    expect(isPublicPath("/api/v1/sensitive-requests/req-1/")).toBe(true);
    expect(isPublicPath("/api/v1/sensitive-requests/req-1/submit")).toBe(true);
    expect(isPublicPath("/api/v1/sensitive-requests/req-1/submit/")).toBe(true);
    expect(isPublicPath("/api/v1/sensitive-requests")).toBe(false);
    expect(isPublicPath("/api/v1/sensitive-requests/req-1/cancel")).toBe(false);
  });

  test("approval-request signer flow is public; cancel stays gated", () => {
    expect(isPublicPath("/api/v1/approval-requests/ap-1")).toBe(true);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/approve")).toBe(true);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/deny")).toBe(true);
    expect(isPublicPath("/api/v1/approval-requests")).toBe(false);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/cancel")).toBe(false);
    expect(isPublicPath("/api/v1/approval-requests/ap-1/approve/extra")).toBe(
      false,
    );
  });

  test("ballot detail + vote are public; tally/distribute/cancel stay gated", () => {
    expect(isPublicPath("/api/v1/ballots/b-1")).toBe(true);
    expect(isPublicPath("/api/v1/ballots/b-1/vote")).toBe(true);
    expect(isPublicPath("/api/v1/ballots")).toBe(false);
    expect(isPublicPath("/api/v1/ballots/b-1/tally")).toBe(false);
    expect(isPublicPath("/api/v1/ballots/b-1/distribute")).toBe(false);
    expect(isPublicPath("/api/v1/ballots/b-1/cancel")).toBe(false);
  });

  test("payment-request detail is public only for GET and HEAD", () => {
    expect(isPublicPath("/api/v1/payment-requests/req-1")).toBe(true);
    expect(isPublicPath("/api/v1/payment-requests/req-1/")).toBe(true);
    expect(isPublicPath("/api/v1/payment-requests/req-1", "HEAD")).toBe(true);
    expect(isPublicPath("/api/v1/payment-requests/req-1", "POST")).toBe(false);
    expect(isPublicPath("/api/v1/payment-requests/req-1", "PATCH")).toBe(false);
    expect(isPublicPath("/api/v1/payment-requests")).toBe(false);
    expect(isPublicPath("/api/v1/payment-requests/req-1/cancel")).toBe(false);
  });
});

describe("isPublicPath — prefix allowlist", () => {
  test.each([...PUBLIC_PREFIXES])(
    "treats exact prefix %s as public",
    (path) => {
      expect(isPublicPath(path)).toBe(true);
      expect(isPublicPath(`${path}/child`)).toBe(true);
    },
  );

  test("prefix match requires the slash boundary (no overflow)", () => {
    expect(isPublicPath("/api/healthcare")).toBe(false);
    expect(isPublicPath("/api/ogre")).toBe(false);
    expect(isPublicPath("/api/cronjob")).toBe(false);
    expect(isPublicPath("/api/agents-extra")).toBe(false);
    expect(isPublicPath("/api/internalize")).toBe(false);
  });

  test("stripe webhook prefix does not expose the authed checkout sibling", () => {
    expect(isPublicPath("/api/v1/stripe/webhook")).toBe(true);
    expect(isPublicPath("/api/v1/stripe/webhook/extra")).toBe(true);
    expect(isPublicPath("/api/v1/stripe/checkout")).toBe(false);
  });

  test("voice session ws is public; mint and revoke siblings stay gated", () => {
    expect(isPublicPath("/api/v1/voice/session/ws")).toBe(true);
    expect(isPublicPath("/api/v1/voice/session/ws/extra")).toBe(true);
    expect(isPublicPath("/api/v1/voice/session")).toBe(false);
    expect(isPublicPath("/api/v1/voice/session/foo")).toBe(false);
  });

  test("empty, root, and non-matching /api paths stay gated", () => {
    expect(isPublicPath("")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api")).toBe(false);
    expect(isPublicPath("/api/")).toBe(false);
    expect(isPublicPath("/api/v1/me")).toBe(false);
    expect(isPublicPath("/api/eliza-app/gateway/agent-1")).toBe(false);
  });

  test("default method is GET", () => {
    expect(isPublicPath("/api/v1/subscriptions/plans")).toBe(
      isPublicPath("/api/v1/subscriptions/plans", "GET"),
    );
  });
});

describe("isRouteAuthenticatedInferencePath", () => {
  test.each([...INFERENCE_PATHS])("allows POST and OPTIONS for %s", (path) => {
    expect(isRouteAuthenticatedInferencePath("POST", path)).toBe(true);
    expect(isRouteAuthenticatedInferencePath("OPTIONS", path)).toBe(true);
    expect(isRouteAuthenticatedInferencePath("POST", `${path}/`)).toBe(true);
  });

  test("rejects lowercase verbs even on a matching path", () => {
    expect(
      isRouteAuthenticatedInferencePath(
        "post",
        "/api/v1/eliza/agents/agent-1/stream",
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedInferencePath(
        "options",
        "/api/v1/eliza/agents/agent-1/stream",
      ),
    ).toBe(false);
  });

  test("never bypasses a state-reading or mutating verb", () => {
    const path =
      "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages";
    expect(isRouteAuthenticatedInferencePath("GET", path)).toBe(false);
    expect(isRouteAuthenticatedInferencePath("HEAD", path)).toBe(false);
    expect(isRouteAuthenticatedInferencePath("PUT", path)).toBe(false);
    expect(isRouteAuthenticatedInferencePath("PATCH", path)).toBe(false);
    expect(isRouteAuthenticatedInferencePath("DELETE", path)).toBe(false);
  });

  test("does not bypass neighboring management and extra-segment paths", () => {
    expect(
      isRouteAuthenticatedInferencePath("POST", "/api/v1/eliza/agents/agent-1"),
    ).toBe(false);
    expect(
      isRouteAuthenticatedInferencePath(
        "POST",
        "/api/v1/eliza/agents/agent-1/suspend",
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedInferencePath(
        "POST",
        "/api/v1/eliza/agents/agent-1/stream/extra",
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedInferencePath(
        "POST",
        "/api/v1/eliza/agents/agent-1/api/conversations",
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedInferencePath(
        "POST",
        "/api/v1/eliza/agents/agent-1/api/conversations/conversation-1/messages/extra",
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedInferencePath("POST", "/api/v1/eliza/agents//stream"),
    ).toBe(false);
  });
});

describe("isRouteAuthenticatedPaidProxyPath", () => {
  test("delegates only the paid proxy method and path inventory", () => {
    const routes = [
      ["GET", "/api/v1/chain/nfts/ethereum/address"],
      ["GET", "/api/v1/chain/tokens/ethereum/address"],
      ["GET", "/api/v1/chain/transfers/ethereum/address"],
      ["GET", "/api/v1/market/candles/ethereum/address"],
      ["GET", "/api/v1/market/portfolio/ethereum/address"],
      ["GET", "/api/v1/market/price/ethereum/address"],
      ["GET", "/api/v1/market/token/ethereum/address"],
      ["GET", "/api/v1/market/trades/ethereum/address"],
      ["POST", "/api/v1/proxy/evm-rpc/ethereum"],
      ["POST", "/api/v1/proxy/solana-rpc"],
      ["POST", "/api/v1/rpc/ethereum"],
      ["GET", "/api/v1/solana/assets/address"],
      ["POST", "/api/v1/solana/rpc"],
      ["GET", "/api/v1/solana/token-accounts/address"],
      ["GET", "/api/v1/solana/transactions/address"],
      ["GET", "/api/v1/apis/birdeye/defi/price"],
    ] as const;

    for (const [method, path] of routes) {
      expect(isRouteAuthenticatedPaidProxyPath(method, path)).toBe(true);
      expect(isRouteAuthenticatedPaidProxyPath("HEAD", path)).toBe(
        method === "GET",
      );
      expect(isRouteAuthenticatedPaidProxyPath("OPTIONS", path)).toBe(true);
    }
  });

  test("does not delegate public previews, reads, internal routes, or neighboring mutations", () => {
    for (const [method, path] of [
      ["GET", "/api/v1/market/preview"],
      ["GET", "/api/v1/models"],
      ["POST", "/api/internal/worker"],
      ["POST", "/api/v1/market/price/ethereum/address"],
      ["GET", "/api/v1/rpc/ethereum"],
      ["HEAD", "/api/v1/rpc/ethereum"],
      ["HEAD", "/api/v1/proxy/evm-rpc/ethereum"],
      ["POST", "/api/v1/rpc/ethereum/extra"],
      ["DELETE", "/api/v1/solana/assets/address"],
    ] as const) {
      expect(isRouteAuthenticatedPaidProxyPath(method, path)).toBe(false);
    }
  });
});

describe("isRouteAuthenticatedRemoteHostRequest", () => {
  test("accepts exact POST activation paths with a well-formed host credential", () => {
    for (const path of [
      "/api/v1/remote/sessions/activate",
      "/api/v1/remote/sessions/activate/",
      `/api/v1/remote/hosts/${REMOTE_HOST_ID}/managed-network/activate`,
      `/api/v1/remote/hosts/${REMOTE_HOST_ID}/managed-network/activate/`,
    ]) {
      expect(
        isRouteAuthenticatedRemoteHostRequest(remoteHostRequest(path)),
      ).toBe(true);
    }
  });

  test("rejects absent, malformed, non-UUID, and path-mismatched credentials", () => {
    const managedPath = `/api/v1/remote/hosts/${REMOTE_HOST_ID}/managed-network/activate`;
    expect(
      isRouteAuthenticatedRemoteHostRequest(
        remoteHostRequest(managedPath, {
          headers: { Authorization: "", "X-Remote-Host-Id": REMOTE_HOST_ID },
        }),
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedRemoteHostRequest(
        remoteHostRequest(managedPath, {
          headers: {
            Authorization: "Bearer rhost_v1_too-short",
            "X-Remote-Host-Id": REMOTE_HOST_ID,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedRemoteHostRequest(
        remoteHostRequest(managedPath, {
          headers: {
            Authorization: `Bearer ${REMOTE_HOST_TOKEN}`,
            "X-Remote-Host-Id": "not-a-uuid",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isRouteAuthenticatedRemoteHostRequest(
        remoteHostRequest(managedPath, {
          headers: {
            Authorization: `Bearer ${REMOTE_HOST_TOKEN}`,
            "X-Remote-Host-Id": OTHER_REMOTE_HOST_ID,
          },
        }),
      ),
    ).toBe(false);
  });

  test("does not delegate neighboring routes, extra segments, or other verbs", () => {
    for (const path of [
      "/api/v1/me",
      "/api/v1/remote/hosts",
      "/api/v1/remote/pair",
      "/api/v1/remote/sessions/activate/extra",
      `/api/v1/remote/hosts/${REMOTE_HOST_ID}/managed-network/activate/extra`,
    ]) {
      expect(
        isRouteAuthenticatedRemoteHostRequest(remoteHostRequest(path)),
      ).toBe(false);
    }
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect(
        isRouteAuthenticatedRemoteHostRequest(
          remoteHostRequest("/api/v1/remote/sessions/activate", { method }),
        ),
      ).toBe(false);
    }
  });
});

describe("authMiddleware", () => {
  test("passes non-/api/ paths through without a session", async () => {
    const res = await dispatch("http://localhost/steward/login");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("passes /api (no trailing slash) through — gate only matches /api/", async () => {
    const res = await dispatch("http://localhost/api");
    expect(res.status).toBe(200);
  });

  test("passes a public prefix through without a session", async () => {
    const res = await dispatch("http://localhost/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("passes a public out-of-band token page through without a session", async () => {
    const res = await dispatch("http://localhost/api/v1/ballots/b-1/vote", {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });

  test("passes POST inference paths through without a session", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/eliza/agents/agent-1/stream",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
  });

  test("delegates only exact remote-host activation requests", async () => {
    for (const path of [
      "/api/v1/remote/sessions/activate",
      `/api/v1/remote/hosts/${REMOTE_HOST_ID}/managed-network/activate`,
    ]) {
      const request = remoteHostRequest(path);
      const res = await dispatch(request.url, {
        method: request.method,
        headers: request.headers,
      });
      expect(res.status).toBe(200);
    }

    for (const path of [
      "/api/v1/me",
      "/api/v1/remote/hosts",
      "/api/v1/remote/pair",
      "/api/v1/remote/sessions/activate/extra",
    ]) {
      const request = remoteHostRequest(path);
      const res = await dispatch(request.url, {
        method: request.method,
        headers: request.headers,
      });
      expect(res.status).toBe(401);
    }
  });

  test("does not treat GET on an inference path as a bypass", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/eliza/agents/agent-1/stream",
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  test("401s a protected /api/ path with no credentials", async () => {
    const res = await dispatch("http://localhost/api/v1/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: "Unauthorized",
      code: "authentication_required",
    });
  });

  test("passes X-API-Key through without resolving a session", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { "X-API-Key": "key-1" },
    });
    expect(res.status).toBe(200);
  });

  test("passes lowercase x-api-key through", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { "x-api-key": "key-1" },
    });
    expect(res.status).toBe(200);
  });

  test("passes X-Service-Key through", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { "X-Service-Key": "svc-1" },
    });
    expect(res.status).toBe(200);
  });

  test("passes lowercase x-service-key through", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { "x-service-key": "svc-1" },
    });
    expect(res.status).toBe(200);
  });

  test("passes Bearer eliza_ through as programmatic auth", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { Authorization: "Bearer eliza_live_abc" },
    });
    expect(res.status).toBe(200);
  });

  test("does not treat a non-eliza Bearer as programmatic auth", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { Authorization: "Bearer not-an-eliza-key" },
    });
    expect(res.status).toBe(401);
  });

  test("does not treat Authorization without the Bearer prefix as programmatic auth", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { Authorization: "eliza_live_abc" },
    });
    expect(res.status).toBe(401);
  });

  test("empty X-API-Key is not programmatic auth", async () => {
    const res = await dispatch("http://localhost/api/v1/me", {
      headers: { "X-API-Key": "" },
    });
    expect(res.status).toBe(401);
  });
});

describe("authMiddleware — local-dev admin bypass", () => {
  beforeEach(() => {
    auditEmits.length = 0;
  });

  test("grants the bypass for loopback admin paths when ELIZA_CLOUD_LOCAL_DEV_ADMIN is set", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/admin/ping",
      { method: "POST", headers: { "cf-connecting-ip": "203.0.113.77" } },
      { NODE_ENV: "development", ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true" },
    );
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = auditEmits.at(-1);
    expect(event?.action).toBe("admin.action");
    expect(event?.actor).toEqual({ type: "system", id: "local-dev-admin" });
    expect(event?.metadata).toEqual({ reason: "local_dev_admin_bypass" });
    expect(event?.ip).toBe("203.0.113.77");
  });

  test("grants the bypass for 127.0.0.1 when LOCAL_DEV is set", async () => {
    const res = await dispatch(
      "http://127.0.0.1/api/v1/admin/ping",
      { method: "GET" },
      { NODE_ENV: "development", LOCAL_DEV: "true" },
    );
    expect(res.status).toBe(200);
  });

  test("grants the bypass for localhost when LOCAL_DEV is set", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/admin/ping",
      { method: "GET" },
      { NODE_ENV: "development", LOCAL_DEV: "true" },
    );
    expect(res.status).toBe(200);
  });

  test("does not treat a bracketed IPv6 loopback hostname as loopback", async () => {
    // WHATWG URL hostname for http://[::1]/... is "[::1]", and
    // isLoopbackHostname compares against "::1" without brackets.
    const res = await dispatch(
      "http://[::1]/api/v1/admin/ping",
      { method: "GET" },
      { NODE_ENV: "development", ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true" },
    );
    expect(res.status).toBe(401);
  });

  test("refuses the bypass in production even when the env flags are set", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/admin/ping",
      { method: "POST" },
      {
        NODE_ENV: "production",
        ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true",
        LOCAL_DEV: "true",
      },
    );
    expect(res.status).toBe(401);
    expect(auditEmits).toHaveLength(0);
  });

  test("does not grant the bypass on a non-loopback hostname", async () => {
    const res = await dispatch(
      "http://example.com/api/v1/admin/ping",
      { method: "GET" },
      { NODE_ENV: "development", ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true" },
    );
    expect(res.status).toBe(401);
  });

  test("does not grant the bypass for non-admin paths", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/me",
      { method: "GET" },
      { NODE_ENV: "development", ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true" },
    );
    expect(res.status).toBe(401);
  });

  test("does not grant the bypass without the env flags", async () => {
    const res = await dispatch(
      "http://localhost/api/v1/admin/ping",
      { method: "GET" },
      { NODE_ENV: "development" },
    );
    expect(res.status).toBe(401);
  });
});
