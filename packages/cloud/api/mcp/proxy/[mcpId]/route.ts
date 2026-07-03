/**
 * User MCP Proxy Endpoint
 *
 * Proxies requests to user-created MCPs and handles monetization.
 *
 * POST /api/mcp/proxy/[mcpId] - Proxy MCP request
 * GET /api/mcp/proxy/[mcpId] - Get MCP info
 */

import {
  calculateCreditMarkup,
  DEFAULT_PLATFORM_FEE_RATE,
} from "@elizaos/cloud-shared/billing";
import { Hono } from "hono";

import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "@/lib/cors-constants";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { safeFetch } from "@/lib/security/safe-fetch";
import { affiliatesService } from "@/lib/services/affiliates";
import { containersService } from "@/lib/services/containers";
import { creditsService } from "@/lib/services/credits";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CREDITS_PER_DOLLAR = 100;

/** JSON subset for proxied MCP-RPC bodies (avoid `unknown`; values are forwarded as JSON). */
export type McpProxyJson =
  | string
  | number
  | boolean
  | null
  | McpProxyJson[]
  | { readonly [key: string]: McpProxyJson };

export function toolNameFromRpcBody(body: McpProxyJson): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "unknown";
  }
  const methodRaw = body.method;
  if (methodRaw !== "tools/call") return "unknown";
  const params = body.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return "unknown";
  }
  const name = params.name;
  return typeof name === "string" && name.length > 0 ? name : "unknown";
}

/**
 * Decide what an `/api/mcp/proxy/[mcpId]` GET caller may see for a `live` MCP.
 *
 * `userMcpsService.getById` is unscoped (no org / is_public filter), and a `live`
 * MCP can still be non-public, so the route must gate access itself (mirrors GET
 * /api/v1/mcps/[mcpId]). Pure + exported so the rule is unit-tested without a
 * live Worker/DB:
 *  - owner (same org)            → full access, real endpoint;
 *  - non-owner of a public MCP   → access, but the platform proxy URL only (the
 *                                  operator's raw external_endpoint is hidden);
 *  - non-owner of a non-public   → no access (route returns the same 404 as a
 *    MCP                           missing one).
 */
export function resolveMcpProxyView(params: {
  mcpOrganizationId: string;
  mcpIsPublic: boolean;
  viewerOrganizationId: string | null | undefined;
}): { allowed: boolean; isOwner: boolean } {
  const isOwner =
    !!params.viewerOrganizationId &&
    params.viewerOrganizationId === params.mcpOrganizationId;
  return { allowed: isOwner || params.mcpIsPublic, isOwner };
}

export async function parseJsonBody(request: Request): Promise<McpProxyJson> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return {};
  }
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as McpProxyJson;
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const mcpId = c.req.param("mcpId");
  if (!mcpId) {
    return c.json({ error: "Missing MCP id" }, 400);
  }

  const mcp = await userMcpsService.getById(mcpId);

  if (!mcp) {
    return c.json({ error: "MCP not found" }, 404);
  }

  if (mcp.status !== "live") {
    return c.json({ error: "MCP is not available" }, 404);
  }

  // Auth is optional so the public MCP catalog stays anonymously browsable;
  // resolveMcpProxyView enforces the owner-or-public access rule.
  const viewer = await requireUserOrApiKeyWithOrg(c).catch(() => null);
  const { allowed, isOwner } = resolveMcpProxyView({
    mcpOrganizationId: mcp.organization_id,
    mcpIsPublic: mcp.is_public,
    viewerOrganizationId: viewer?.organization_id,
  });
  if (!allowed) {
    return c.json({ error: "MCP not found" }, 404);
  }

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL ?? "https://www.elizacloud.ai";

  return c.json({
    id: mcp.id,
    name: mcp.name,
    description: mcp.description,
    tools: mcp.tools,
    pricing: {
      type: mcp.pricing_type,
      creditsPerRequest: mcp.credits_per_request,
      x402PriceUsd: mcp.x402_price_usd,
      x402Enabled: mcp.x402_enabled,
    },
    // Owners see the real endpoint (incl. their own external URL); non-owners
    // browsing a public MCP get the platform proxy URL so the operator's raw
    // external_endpoint is never disclosed.
    endpoint: isOwner
      ? userMcpsService.getEndpointUrl(mcp, baseUrl)
      : `${baseUrl}/api/mcp/proxy/${mcp.id}`,
    transport: mcp.transport_type,
  });
});

app.post("/", async (c) => {
  const startTime = Date.now();
  const mcpId = c.req.param("mcpId");
  if (!mcpId) {
    return c.json({ error: "Missing MCP id" }, 400);
  }

  const user = await requireUserOrApiKeyWithOrg(c).catch(() => null);

  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const mcp = await userMcpsService.getById(mcpId);

  if (!mcp) {
    return c.json({ error: "MCP not found" }, 404);
  }

  if (mcp.status !== "live") {
    return c.json({ error: "MCP is not available" }, 404);
  }

  const creditsRequired = Number(mcp.credits_per_request || "1");
  let affiliateOwnerId: string | undefined;
  let affiliateCodeId: string | undefined;

  const referrerPromise = affiliatesService
    .getReferrer(user.id)
    .catch((error: Error | string) => {
      logger.error("[MCP Proxy] Failed to resolve affiliate referrer", {
        mcpId,
        userId: user.id,
        error: typeof error === "string" ? error : error.message,
      });
      return null;
    });
  const referrer = await referrerPromise;
  if (referrer) {
    affiliateOwnerId = referrer.user_id;
    affiliateCodeId = referrer.id;
  }

  const {
    markupCredits: affiliateFeeCredits,
    platformFeeCredits,
    totalCredits: totalCreditsRequired,
  } = calculateCreditMarkup({
    baseCredits: creditsRequired,
    markupPercent: referrer ? Number(referrer.markup_percent) : 0,
    platformFeeRate: referrer ? DEFAULT_PLATFORM_FEE_RATE : 0,
  });

  const preChargeResult = await creditsService.reserveAndDeductCredits({
    organizationId: user.organization_id,
    amount: totalCreditsRequired / CREDITS_PER_DOLLAR,
    description: `MCP: ${mcp.name}`,
    metadata: {
      mcp_id: mcp.id,
      mcp_name: mcp.name,
      reserved: true,
      base_credits: creditsRequired.toFixed(4),
      affiliate_fee: affiliateFeeCredits.toFixed(4),
      platform_fee: platformFeeCredits.toFixed(4),
      total_credits_charged: totalCreditsRequired.toFixed(4),
      ...(affiliateOwnerId && { affiliate_owner_id: affiliateOwnerId }),
      ...(affiliateCodeId && { affiliate_code_id: affiliateCodeId }),
    },
  });

  if (!preChargeResult.success) {
    return c.json(
      {
        error: "Insufficient credits",
        required: totalCreditsRequired,
        balance: preChargeResult.newBalance,
      },
      402,
    );
  }

  // The caller was debited upfront; ANY post-debit failure (unsafe/misconfigured
  // endpoint, unreachable upstream, container down, non-ok status) must return
  // the money — otherwise a momentarily-down MCP silently over-charges the org
  // (#11637). Refund on every failure branch, not only a non-ok HTTP status.
  let refundedPrecharge = false;
  const refundPrecharge = async (
    reason: string,
    metadata: Record<string, string | number | boolean | null | undefined> = {},
  ): Promise<void> => {
    if (refundedPrecharge) return;
    refundedPrecharge = true;
    await creditsService
      .refundCredits({
        organizationId: user.organization_id,
        amount: totalCreditsRequired / CREDITS_PER_DOLLAR,
        description: `MCP refund: ${mcp.name} (${reason})`,
        metadata: {
          mcp_id: mcp.id,
          reason,
          ...metadata,
        },
      })
      .catch((refundError: Error | string) => {
        logger.error("[MCP Proxy] Failed to refund credits", {
          mcpId,
          reason,
          error:
            typeof refundError === "string" ? refundError : refundError.message,
        });
      });
  };

  let targetUrl: string;
  // External (user-configured) endpoints are fetched through safeFetch below,
  // which re-validates AND pins the resolved IP for the actual request (closing
  // the validate-then-fetch TOCTOU / DNS-rebind window on the Node path).
  // Container endpoints resolve to a platform-internal load-balancer URL on the
  // private tailnet, which safeFetch would (correctly) reject as a private IP —
  // so those stay on the platform fetch.
  let isExternalEndpoint = false;

  if (mcp.endpoint_type === "external" && mcp.external_endpoint) {
    let parsed: URL;
    try {
      parsed = await assertSafeOutboundUrl(mcp.external_endpoint);
    } catch (error) {
      logger.warn("[MCP Proxy] Blocked unsafe external endpoint", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      await refundPrecharge("unsafe_endpoint");
      return c.json({ error: "Unsafe external MCP endpoint" }, 400);
    }
    targetUrl = parsed.toString();
    isExternalEndpoint = true;
  } else if (mcp.endpoint_type === "container" && mcp.container_id) {
    let container: Awaited<ReturnType<typeof containersService.getById>>;
    try {
      container = await containersService.getById(
        mcp.container_id,
        mcp.organization_id,
      );
    } catch (error) {
      logger.error("[MCP Proxy] Failed to resolve MCP container", {
        mcpId,
        containerId: mcp.container_id,
        error: error instanceof Error ? error.message : String(error),
      });
      await refundPrecharge("container_lookup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "MCP container not available" }, 502);
    }
    if (!container?.load_balancer_url) {
      await refundPrecharge("container_unavailable");
      return c.json({ error: "MCP container not available" }, 503);
    }
    targetUrl = `${container.load_balancer_url}${mcp.endpoint_path || "/mcp"}`;
  } else {
    await refundPrecharge("endpoint_misconfigured");
    return c.json({ error: "MCP endpoint not configured" }, 500);
  }

  let proxyBody: McpProxyJson;
  try {
    proxyBody = await parseJsonBody(c.req.raw);
  } catch (error) {
    logger.warn("[MCP Proxy] Invalid JSON request body", {
      mcpId,
      error: error instanceof Error ? error.message : String(error),
    });
    await refundPrecharge("invalid_json");
    return c.json({ error: "Invalid MCP request body" }, 400);
  }
  const toolName = toolNameFromRpcBody(proxyBody);

  const proxyRequestInit: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(c.req.header("accept") && {
        Accept: c.req.header("accept"),
      }),
    },
    body: JSON.stringify(proxyBody),
  };

  let mcpResponse: Response;
  try {
    if (isExternalEndpoint) {
      // safeFetch validates + IP-pins the request and (redirect: "error")
      // rejects any redirect — the single SSRF guard for outbound-from-user
      // fetches, replacing the prior validate-then-raw-fetch pair.
      mcpResponse = await safeFetch(targetUrl, {
        ...proxyRequestInit,
        redirect: "error",
      });
    } else {
      // Platform-internal container LB URL (private tailnet) — not a user-input
      // SSRF surface; keep the platform fetch with the manual redirect block.
      mcpResponse = await fetch(targetUrl, {
        ...proxyRequestInit,
        redirect: "manual",
      });
      if (mcpResponse.status >= 300 && mcpResponse.status < 400) {
        throw new Error("External MCP redirects are not allowed");
      }
    }
  } catch (error) {
    logger.error("[MCP Proxy] Failed to reach MCP endpoint", {
      mcpId,
      targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    await refundPrecharge("upstream_unreachable");
    return c.json({ error: "Failed to reach MCP endpoint" }, 502);
  }

  let responseBody: string;
  try {
    responseBody = await mcpResponse.text();
  } catch (error) {
    logger.error("[MCP Proxy] Failed to read MCP response body", {
      mcpId,
      status: mcpResponse.status,
      error: error instanceof Error ? error.message : String(error),
    });
    await refundPrecharge("mcp_response_read_failed", {
      status: mcpResponse.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to read MCP response" }, 502);
  }

  if (mcpResponse.ok) {
    await userMcpsService
      .recordUsageWithoutDeduction({
        mcpId: mcp.id,
        organizationId: user.organization_id,
        userId: user.id,
        toolName,
        creditsCharged: creditsRequired,
        affiliateFeeCredits,
        platformFeeCredits,
        affiliateOwnerId,
        affiliateCodeId,
        metadata: {
          responseTime: Date.now() - startTime,
          success: true,
          preChargeTransactionId: preChargeResult.transaction?.id,
          totalCreditsCharged: totalCreditsRequired,
          affiliateFeeCredits,
          platformFeeCredits,
        },
      })
      .catch((usageError: Error | string) => {
        logger.error("[MCP Proxy] Failed to record usage", {
          mcpId,
          error:
            typeof usageError === "string" ? usageError : usageError.message,
        });
      });
  } else {
    await refundPrecharge("mcp_call_failed", { status: mcpResponse.status });
  }

  return new Response(responseBody, {
    status: mcpResponse.status,
    headers: {
      "Content-Type":
        mcpResponse.headers.get("content-type") || "application/json",
      "X-MCP-Id": mcp.id,
      "X-MCP-Name": mcp.name,
    },
  });
});

app.options("/", () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    },
  });
});

export default app;
