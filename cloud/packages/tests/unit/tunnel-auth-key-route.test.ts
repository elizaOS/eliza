import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const ORG_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface CapturedHeadscaleCall {
  clientOpts?: { apiUrl?: string; apiKey?: string; user?: string };
  createOpts?: {
    reusable?: boolean;
    ephemeral?: boolean;
    expiration?: string;
    aclTags?: string[];
  };
  debitOpts?: {
    organizationId: string;
    amount: number;
    description: string;
    metadata?: Record<string, unknown>;
  };
  refundOpts?: {
    organizationId: string;
    amount: number;
    description: string;
    metadata?: Record<string, unknown>;
  };
}

function installMocks(
  captured: CapturedHeadscaleCall,
  options: {
    debitResult?: { success: boolean; newBalance: number; transaction: unknown };
    createError?: Error;
  } = {},
): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => ({
      id: USER_ID,
      organization_id: ORG_ID,
      organization: { id: ORG_ID, is_active: true },
      is_active: true,
    }),
  }));

  mock.module("@/lib/services/credits", () => ({
    creditsService: {
      deductCredits: async (opts: CapturedHeadscaleCall["debitOpts"]) => {
        captured.debitOpts = opts;
        return options.debitResult ?? { success: true, newBalance: 9.99, transaction: {} };
      },
      refundCredits: async (opts: CapturedHeadscaleCall["refundOpts"]) => {
        captured.refundOpts = opts;
        return { transaction: {}, newBalance: 10 };
      },
    },
  }));

  mock.module("@/lib/services/headscale-client", () => ({
    HeadscaleClient: class {
      constructor(opts: { apiUrl?: string; apiKey?: string; user?: string }) {
        captured.clientOpts = opts;
      }

      async createPreAuthKey(opts: CapturedHeadscaleCall["createOpts"]) {
        if (options.createError) throw options.createError;
        captured.createOpts = opts;
        return {
          id: "1",
          key: "hskey-auth-test",
          reusable: false,
          ephemeral: true,
          used: false,
          expiration: opts?.expiration ?? "2026-05-10T13:00:00.000Z",
        };
      }
    },
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  }));
}

async function loadRoute(): Promise<{
  fetch(req: Request, env?: Record<string, unknown>): Response | Promise<Response>;
}> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/apis/tunnels/tailscale/auth-key/route.ts?test=${Date.now()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const app = new Hono();
  app.route("/api/v1/apis/tunnels/tailscale/auth-key", inner);
  return app;
}

function request(body: unknown = {}): Request {
  return new Request("https://api.elizacloud.ai/api/v1/apis/tunnels/tailscale/auth-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const env = {
  HEADSCALE_PUBLIC_URL: "https://headscale.elizacloud.ai",
  HEADSCALE_API_URL: "https://headscale.internal",
  HEADSCALE_API_KEY: "headscale-api-key",
  HEADSCALE_USER: "tunnel",
  TUNNEL_PROXY_HOST: "tunnel.elizacloud.ai",
  TUNNEL_TAILNET_DOMAIN: "tunnel.eliza.local",
  TUNNEL_AUTH_KEY_COST_USD: "0.01",
  TUNNEL_HOSTNAME_SIGNING_SECRET: "test-tunnel-hostname-signing-secret",
};

describe("tunnel auth-key route", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("mints an ephemeral customer-tunnel Headscale key", async () => {
    const captured: CapturedHeadscaleCall = {};
    installMocks(captured);
    const app = await loadRoute();

    const res = await app.fetch(request({ tags: ["tag:agent"], expirySeconds: 300 }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.authKey).toBe("hskey-auth-test");
    expect(body.loginServer).toBe("https://headscale.elizacloud.ai");
    expect(body.tailnet).toBe("https://headscale.elizacloud.ai");
    expect(String(body.magicDnsName)).toEndWith(".tunnel.elizacloud.ai");
    expect(String(body.hostname)).toStartWith("eliza-111111112222-");
    expect(String(body.hostname)).toMatch(
      /^eliza-111111112222-[a-f0-9]{20}-[a-f0-9]{16}$/,
    );
    expect(body.tags).toEqual(["tag:eliza-tunnel"]);
    expect(body.billing).toEqual({
      model: "on_demand",
      unit: "tunnel_auth_key",
      charged: true,
      amountUsd: 0.01,
      subscription: false,
    });
    expect(captured.debitOpts).toMatchObject({
      organizationId: ORG_ID,
      amount: 0.01,
      description: "API: cloud tunnel provisioning",
    });
    expect(captured.debitOpts?.metadata).toMatchObject({
      type: "tunnel",
      billing_model: "on_demand",
      unit: "tunnel_auth_key",
      service: "headscale",
      method: "auth-key.create",
      organization_id: ORG_ID,
      user_id: USER_ID,
      tags: ["tag:eliza-tunnel"],
    });
    expect(captured.clientOpts).toEqual({
      apiUrl: "https://headscale.internal",
      apiKey: "headscale-api-key",
      user: "tunnel",
    });
    expect(captured.createOpts?.reusable).toBe(false);
    expect(captured.createOpts?.ephemeral).toBe(true);
    expect(captured.createOpts?.aclTags).toEqual(["tag:eliza-tunnel"]);
  });

  test("returns 402 and does not mint a key when org credits are insufficient", async () => {
    const captured: CapturedHeadscaleCall = {};
    installMocks(captured, {
      debitResult: { success: false, newBalance: 0, transaction: null },
    });
    const app = await loadRoute();

    const res = await app.fetch(request(), env);
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.error).toBe("Insufficient credits");
    expect(body.requiredCredits).toBe(0.01);
    expect(body.billing).toEqual({
      model: "on_demand",
      unit: "tunnel_auth_key",
      charged: false,
      amountUsd: 0.01,
      subscription: false,
    });
    expect(captured.createOpts).toBeUndefined();
  });

  test("refunds the provisioning debit when Headscale key creation fails", async () => {
    const captured: CapturedHeadscaleCall = {};
    installMocks(captured, { createError: new Error("headscale unavailable") });
    const app = await loadRoute();

    const res = await app.fetch(request(), env);
    expect(res.status).toBe(500);

    expect(captured.debitOpts?.amount).toBe(0.01);
    expect(captured.refundOpts).toMatchObject({
      organizationId: ORG_ID,
      amount: 0.01,
      description: "Refund: cloud tunnel provisioning failed",
    });
    expect(captured.refundOpts?.metadata).toMatchObject({
      refund_reason: "headscale_preauth_key_failed",
      type: "tunnel",
      unit: "tunnel_auth_key",
    });
  });

  test("returns 503 when Headscale secrets are not configured", async () => {
    const captured: CapturedHeadscaleCall = {};
    installMocks(captured);
    const app = await loadRoute();

    const res = await app.fetch(request(), {
      HEADSCALE_PUBLIC_URL: "https://headscale.elizacloud.ai",
    });

    expect(res.status).toBe(503);
    expect(captured.clientOpts).toBeUndefined();
    expect(captured.debitOpts).toBeUndefined();
  });
});
