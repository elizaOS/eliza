/**
 * POST /api/v1/apis/tunnels/tailscale/auth-key
 *
 * Mints a short-lived Headscale pre-auth key for the Eliza Cloud tunnel
 * backend used by @elizaos/plugin-tailscale. Client-supplied tags are treated
 * as advisory only; the server always applies the locked-down customer-tunnel
 * service tag from services/headscale/acl.hujson.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { HeadscaleClient } from "@/lib/services/headscale-client";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CUSTOMER_TUNNEL_TAG = "tag:eliza-tunnel";
const DEFAULT_EXPIRY_SECONDS = 60 * 60;
const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const DEFAULT_TUNNEL_AUTH_KEY_COST_USD = 0.01;
const MAX_TUNNEL_AUTH_KEY_COST_USD = 1;
const TUNNEL_BILLING_UNIT = "tunnel_auth_key";

const authKeyRequestSchema = z
  .object({
    tags: z.array(z.string().min(1)).max(10).optional(),
    expirySeconds: z.number().int().min(MIN_EXPIRY_SECONDS).max(MAX_EXPIRY_SECONDS).optional(),
  })
  .default({});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = authKeyRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid tunnel auth-key request", details: parsed.error.issues },
        400,
      );
    }

    const headscaleApiUrl = readEnv(c.env.HEADSCALE_API_URL) ?? readEnv(c.env.HEADSCALE_PUBLIC_URL);
    const headscalePublicUrl = readEnv(c.env.HEADSCALE_PUBLIC_URL) ?? headscaleApiUrl;
    const headscaleApiKey = readEnv(c.env.HEADSCALE_API_KEY);
    const headscaleUser = readEnv(c.env.HEADSCALE_USER) ?? "tunnel";
    const tunnelProxyHost = readEnv(c.env.TUNNEL_PROXY_HOST);
    const tailnetDomain = readEnv(c.env.TUNNEL_TAILNET_DOMAIN) ?? "tunnel.eliza.local";
    const tunnelAuthKeyCostUsd = readUsdAmount(
      c.env.TUNNEL_AUTH_KEY_COST_USD,
      DEFAULT_TUNNEL_AUTH_KEY_COST_USD,
    );

    if (!headscaleApiUrl || !headscalePublicUrl || !headscaleApiKey) {
      return c.json(
        {
          error:
            "Headscale tunnel auth is not configured. Set HEADSCALE_PUBLIC_URL, HEADSCALE_API_URL, and HEADSCALE_API_KEY.",
        },
        503,
      );
    }

    const expirySeconds = parsed.data.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
    const expiration = new Date(Date.now() + expirySeconds * 1000).toISOString();
    const hostname = makeTunnelHostname(user.organization_id);
    const publicHost = tunnelProxyHost
      ? `${hostname}.${tunnelProxyHost}`
      : `${hostname}.${tailnetDomain}`;
    const billingMetadata = {
      type: "tunnel",
      billing_model: "on_demand",
      unit: TUNNEL_BILLING_UNIT,
      service: "headscale",
      method: "auth-key.create",
      organization_id: user.organization_id,
      user_id: user.id,
      hostname,
      public_host: publicHost,
      expires_at: expiration,
      requested_expiry_seconds: expirySeconds,
      tags: [CUSTOMER_TUNNEL_TAG],
    };

    let charged = false;
    if (tunnelAuthKeyCostUsd > 0) {
      const debit = await creditsService.deductCredits({
        organizationId: user.organization_id,
        amount: tunnelAuthKeyCostUsd,
        description: "API: cloud tunnel provisioning",
        metadata: billingMetadata,
      });
      if (!debit.success) {
        return c.json(
          {
            error: "Insufficient credits",
            requiredCredits: tunnelAuthKeyCostUsd,
            currentBalance: debit.newBalance,
            topUpUrl: "https://www.elizacloud.ai/dashboard/billing",
            billing: tunnelBilling(tunnelAuthKeyCostUsd, false),
          },
          402,
        );
      }
      charged = true;
    }

    const client = new HeadscaleClient({
      apiUrl: headscaleApiUrl,
      apiKey: headscaleApiKey,
      user: headscaleUser,
    });
    let preAuthKey: Awaited<ReturnType<HeadscaleClient["createPreAuthKey"]>>;
    try {
      preAuthKey = await client.createPreAuthKey({
        reusable: false,
        ephemeral: true,
        expiration,
        aclTags: [CUSTOMER_TUNNEL_TAG],
      });
    } catch (error) {
      if (charged) {
        await refundTunnelCharge(user.organization_id, tunnelAuthKeyCostUsd, billingMetadata);
      }
      throw error;
    }

    return c.json({
      authKey: preAuthKey.key,
      tailnet: headscalePublicUrl,
      loginServer: headscalePublicUrl,
      hostname,
      magicDnsName: publicHost,
      expiresAt: preAuthKey.expiration || expiration,
      tags: [CUSTOMER_TUNNEL_TAG],
      billing: tunnelBilling(tunnelAuthKeyCostUsd, charged),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

function readEnv(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : null;
}

function makeTunnelHostname(organizationId: string): string {
  const orgPart =
    organizationId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || "org";
  const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return `eliza-${orgPart}-${randomPart}`;
}

function readUsdAmount(value: unknown, fallback: number): number {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value.trim());
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > MAX_TUNNEL_AUTH_KEY_COST_USD
  ) {
    return fallback;
  }
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function tunnelBilling(amountUsd: number, charged: boolean) {
  return {
    model: "on_demand",
    unit: TUNNEL_BILLING_UNIT,
    charged,
    amountUsd,
    subscription: false,
  };
}

async function refundTunnelCharge(
  organizationId: string,
  amount: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await creditsService.refundCredits({
      organizationId,
      amount,
      description: "Refund: cloud tunnel provisioning failed",
      metadata: {
        ...metadata,
        refund_reason: "headscale_preauth_key_failed",
      },
    });
  } catch (refundError) {
    logger.error("[TunnelAuthKey] Failed to refund provisioning charge", {
      organizationId,
      amount,
      error: refundError instanceof Error ? refundError.message : String(refundError),
    });
  }
}

export default app;
