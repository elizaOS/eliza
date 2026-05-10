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
}

function installMocks(captured: CapturedHeadscaleCall): void {
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
      deductCredits: async () => ({ success: true }),
    },
  }));

  mock.module("@/lib/services/headscale-client", () => ({
    HeadscaleClient: class {
      constructor(opts: { apiUrl?: string; apiKey?: string; user?: string }) {
        captured.clientOpts = opts;
      }

      async createPreAuthKey(opts: CapturedHeadscaleCall["createOpts"]) {
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
    expect(body.tags).toEqual(["tag:eliza-tunnel"]);
    expect(captured.clientOpts).toEqual({
      apiUrl: "https://headscale.internal",
      apiKey: "headscale-api-key",
      user: "tunnel",
    });
    expect(captured.createOpts?.reusable).toBe(false);
    expect(captured.createOpts?.ephemeral).toBe(true);
    expect(captured.createOpts?.aclTags).toEqual(["tag:eliza-tunnel"]);
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
  });
});
