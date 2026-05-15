/**
 * User MCP Proxy Endpoint
 *
 * Proxies requests to user-created MCPs and handles monetization.
 *
 * POST /api/mcp/proxy/[mcpId] - Proxy MCP request
 * GET /api/mcp/proxy/[mcpId] - Get MCP info
 */

import { Hono } from "hono";

import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from "@/lib/cors-constants";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { affiliatesService } from "@/lib/services/affiliates";
import { containersService } from "@/lib/services/containers";
import { creditsService } from "@/lib/services/credits";
import { userMcpsService } from "@/lib/services/user-mcps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CREDITS_PER_DOLLAR = 100;

/** JSON subset for proxied MCP-RPC bodies (avoid `unknown`; values are forwarded as JSON). */
type McpProxyJson =
  | string
  | number
  | boolean
  | null
  | McpProxyJson[]
  | { readonly [key: string]: McpProxyJson };

function toolNameFromRpcBody(body: McpProxyJson): string {
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

async function parseJsonBody(request: Request): Promise<McpProxyJson> {
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
    endpoint: userMcpsService.getEndpointUrl(mcp, baseUrl),
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
  let affiliateFeeCredits = 0;
  let platformFeeCredits = 0;
  let affiliateOwnerId: string | undefined;
  let affiliateCodeId: string | undefined;

  const referrerPromise = affiliatesService.getReferrer(user.id).catch((error: Error | string) => {
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
    affiliateFeeCredits = creditsRequired * (Number(referrer.markup_percent) / 100);
    platformFeeCredits = creditsRequired * 0.2;
  }

  const totalCreditsRequired = creditsRequired + affiliateFeeCredits + platformFeeCredits;

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

  let targetUrl: string;

  if (mcp.endpoint_type === "external" && mcp.external_endpoint) {
    let parsed: URL;
    try {
      parsed = await assertSafeOutboundUrl(mcp.external_endpoint);
    } catch (error) {
      logger.warn("[MCP Proxy] Blocked unsafe external endpoint", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Unsafe external MCP endpoint" }, 400);
    }
    targetUrl = parsed.toString();
  } else if (mcp.endpoint_type === "container" && mcp.container_id) {
    const container = await containersService.getById(mcp.container_id, mcp.organization_id);
    if (!container || !container.load_balancer_url) {
      return c.json({ error: "MCP container not available" }, 503);
    }
    targetUrl = `${container.load_balancer_url}${mcp.endpoint_path || "/mcp"}`;
  } else {
    return c.json({ error: "MCP endpoint not configured" }, 500);
  }

  const proxyBody = await parseJsonBody(c.req.raw);
  const toolName = toolNameFromRpcBody(proxyBody);

  let mcpResponse: Response;
  try {
    mcpResponse = await fetch(targetUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(c.req.header("accept") && {
          Accept: c.req.header("accept"),
        }),
      },
      body: JSON.stringify(proxyBody),
    });

    if (mcpResponse.status >= 300 && mcpResponse.status < 400) {
      throw new Error("External MCP redirects are not allowed");
    }
  } catch (error) {
    logger.error("[MCP Proxy] Failed to reach MCP endpoint", {
      mcpId,
      targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to reach MCP endpoint" }, 502);
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
          error: typeof usageError === "string" ? usageError : usageError.message,
        });
      });
  } else {
    await creditsService
      .refundCredits({
        organizationId: user.organization_id,
        amount: totalCreditsRequired / CREDITS_PER_DOLLAR,
        description: `MCP refund: ${mcp.name} (failed)`,
        metadata: {
          mcp_id: mcp.id,
          reason: "mcp_call_failed",
          status: mcpResponse.status,
        },
      })
      .catch((refundError: Error | string) => {
        logger.error("[MCP Proxy] Failed to refund credits", {
          mcpId,
          error: typeof refundError === "string" ? refundError : refundError.message,
        });
      });
  }

  const responseBody = await mcpResponse.text();

  return new Response(responseBody, {
    status: mcpResponse.status,
    headers: {
      "Content-Type": mcpResponse.headers.get("content-type") || "application/json",
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
