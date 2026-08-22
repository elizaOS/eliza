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
  formatOrganizationCreditUsd,
  mcpUsageChargeReceiptFromLegacyPoints,
  ORGANIZATION_CREDIT_UNIT,
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
import {
  createMcpProxyHopDeadline,
  isMcpProxyHopDeadline,
  readBodyTextWithinBudget,
} from "./proxy-body-budget";

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
 * Detect a JSON-RPC 2.0 error envelope in an MCP response body.
 *
 * error-policy:J4 — MCP servers speak JSON-RPC 2.0, where a *failed* tool call
 * is returned as HTTP 200 with a top-level `{ "error": { "code", "message" } }`
 * envelope (the transport succeeded, the RPC did not). Billing keyed only on the
 * HTTP status (`mcpResponse.ok`) therefore charges the caller for a tool call the
 * MCP never completed — the same silent over-charge class #11637 closed for the
 * HTTP layer, still open at the JSON-RPC layer. This surfaces the protocol-level
 * failure so the pre-charge is refunded instead of success-shaped into a bill.
 *
 * Conservative by design: only a JSON-RPC `error` member that is itself an object
 * carrying a numeric `code` counts. A `result` payload, a bare/absent `error`, an
 * unparseable body, or a plain object without the RPC error shape is NOT treated
 * as a failure here (an unparseable success-shaped body is still delivered to the
 * caller and billed — this helper never *fabricates* a failure, only recognises an
 * explicit one), so a well-behaved success is never wrongly refunded.
 */
export function isJsonRpcErrorResponse(responseBody: string): boolean {
  const text = responseBody.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparseable body: not an *explicit* JSON-RPC error. Do not fabricate a
    // failure — let the existing success path bill it (transport was 2xx).
    return false;
  }
  const isRpcError = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const err = (value as { error?: unknown }).error;
    if (err === null || typeof err !== "object" || Array.isArray(err)) {
      return false;
    }
    // A JSON-RPC 2.0 error object is required to carry an integer `code`.
    return typeof (err as { code?: unknown }).code === "number";
  };
  // Batched JSON-RPC responses come back as an array; treat the batch as failed
  // if EVERY entry is an error envelope (a partial success still delivers value
  // and should bill — refunding a partial batch would under-charge).
  if (Array.isArray(parsed)) {
    return parsed.length > 0 && parsed.every((entry) => isRpcError(entry));
  }
  return isRpcError(parsed);
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

/**
 * Byte budgets for the two bodies this route buffers into the isolate.
 *
 * The numbers are not new: `@/lib/services/oauth/credential-broker.ts` — the
 * platform's other "proxy one call to a caller-supplied host" service — caps
 * the request body it accepts at 1 MB and derives its response budget from that
 * cap so the two halves cannot drift (#23900). Same shape of hop, same numbers,
 * derived the same way rather than written as a second pair of literals.
 */
const MAX_PROXY_REQUEST_BODY_BYTES = 1_000_000;
const PROXY_RESPONSE_BODY_BUDGET_MULTIPLIER = 5;
const MAX_PROXY_RESPONSE_BODY_BYTES =
  MAX_PROXY_REQUEST_BODY_BYTES * PROXY_RESPONSE_BODY_BUDGET_MULTIPLIER;

/** Raised by `parseJsonBody` when the caller's body is over budget. */
export class McpProxyBodyTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;
  constructor(bytes: number, maxBytes: number) {
    super(`MCP proxy body exceeds the ${maxBytes}-byte limit (${bytes})`);
    this.name = "McpProxyBodyTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export async function parseJsonBody(
  request: Request,
  maxBytes: number = MAX_PROXY_REQUEST_BODY_BYTES,
): Promise<McpProxyJson> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return {};
  }
  // Charge the budget before the bytes are retained: reading the whole body and
  // measuring it afterwards spends the memory the measurement exists to refuse.
  const budgeted = await readBodyTextWithinBudget(request, maxBytes);
  if (!budgeted.ok) {
    throw new McpProxyBodyTooLargeError(budgeted.bytes, maxBytes);
  }
  const text = budgeted.text;
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

  const baseUrl = c.env.NEXT_PUBLIC_APP_URL ?? "https://cloud.eliza.app";
  const apiMcp = userMcpsService.toApiMcp(mcp);

  return c.json({
    id: mcp.id,
    name: mcp.name,
    description: mcp.description,
    tools: mcp.tools,
    pricing: {
      type: mcp.pricing_type,
      creditUnit: apiMcp.credit_unit,
      priceUsd: apiMcp.price_usd,
      priceAvailable: apiMcp.price_available,
      /** @deprecated Legacy MCP pricing points (100 points = $1). */
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

  // Owner-or-public gate (mirrors the GET handler): getById is unscoped and the
  // catalog hides private MCPs, so without this a non-owner org could INVOKE
  // another org's private live MCP — hitting the owner's backend/credentials
  // while the caller is billed (cross-tenant IDOR, #11838). Public MCPs stay
  // invokable by anyone (the monetization model); private MCPs are owner-only.
  const { allowed } = resolveMcpProxyView({
    mcpOrganizationId: mcp.organization_id,
    mcpIsPublic: mcp.is_public,
    viewerOrganizationId: user.organization_id,
  });
  if (!allowed) {
    return c.json({ error: "MCP not found" }, 404);
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
  const chargeReceipt = mcpUsageChargeReceiptFromLegacyPoints({
    basePoints: creditsRequired,
    affiliateFeePoints: affiliateFeeCredits,
    platformFeePoints: platformFeeCredits,
  });

  const preChargeResult = await creditsService.reserveAndDeductCredits({
    organizationId: user.organization_id,
    amount: chargeReceipt.totalAmountUsd,
    description: `MCP: ${mcp.name}`,
    metadata: {
      mcp_id: mcp.id,
      mcp_name: mcp.name,
      reserved: true,
      base_credits: creditsRequired.toFixed(4),
      affiliate_fee: affiliateFeeCredits.toFixed(4),
      platform_fee: platformFeeCredits.toFixed(4),
      total_credits_charged: totalCreditsRequired.toFixed(4),
      base_amount_usd: formatOrganizationCreditUsd(chargeReceipt.baseAmountUsd),
      affiliate_fee_usd: formatOrganizationCreditUsd(
        chargeReceipt.affiliateFeeUsd,
      ),
      platform_fee_usd: formatOrganizationCreditUsd(
        chargeReceipt.platformFeeUsd,
      ),
      total_amount_usd: formatOrganizationCreditUsd(
        chargeReceipt.totalAmountUsd,
      ),
      credit_unit: ORGANIZATION_CREDIT_UNIT,
      ...(affiliateOwnerId && { affiliate_owner_id: affiliateOwnerId }),
      ...(affiliateCodeId && { affiliate_code_id: affiliateCodeId }),
    },
  });

  if (!preChargeResult.success) {
    return c.json(
      {
        error: "Insufficient credits",
        creditUnit: ORGANIZATION_CREDIT_UNIT,
        requiredUsd: chargeReceipt.totalAmountUsd,
        /** @deprecated Legacy MCP pricing points (100 points = $1). */
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
        amount: chargeReceipt.totalAmountUsd,
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
    if (error instanceof McpProxyBodyTooLargeError) {
      logger.warn("[MCP Proxy] Request body exceeded the proxy byte budget", {
        mcpId,
        bytes: error.bytes,
        maxBytes: error.maxBytes,
      });
      await refundPrecharge("request_body_too_large", {
        maxBytes: error.maxBytes,
      });
      return c.json({ error: "MCP request body is too large" }, 413);
    }
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

  const hop = createMcpProxyHopDeadline(c.req.raw.signal);
  const refundDeadline = async (): Promise<Response> => {
    logger.warn("[MCP Proxy] MCP hop exceeded the proxy deadline", {
      mcpId,
      timeoutMs: hop.timeoutMs,
    });
    await refundPrecharge("upstream_deadline_exceeded", {
      timeoutMs: hop.timeoutMs,
    });
    return c.json({ error: "MCP endpoint timed out" }, 504);
  };

  let mcpResponse: Response;
  try {
    try {
      if (isExternalEndpoint) {
        // safeFetch validates + IP-pins the request and (redirect: "error")
        // rejects any redirect — the single SSRF guard for outbound-from-user
        // fetches, replacing the prior validate-then-raw-fetch pair.
        mcpResponse = await safeFetch(targetUrl, {
          ...proxyRequestInit,
          redirect: "error",
          signal: hop.signal,
        });
      } else {
        // Platform-internal container LB URL (private tailnet) — not a user-input
        // SSRF surface; keep the platform fetch with the manual redirect block.
        mcpResponse = await fetch(targetUrl, {
          ...proxyRequestInit,
          redirect: "manual",
          signal: hop.signal,
        });
        if (mcpResponse.status >= 300 && mcpResponse.status < 400) {
          throw new Error("External MCP redirects are not allowed");
        }
      }
    } catch (error) {
      // error-policy:J1 hop abort maps to a 504 refund; other failures stay 502.
      if (isMcpProxyHopDeadline(hop.signal, error) || hop.signal.aborted) {
        return await refundDeadline();
      }
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
      // The far end of this read is a URL the MCP's owner chose. Charge the
      // budget before the bytes are retained — a catch below can report a read
      // failure but cannot give back memory the isolate has already spent.
      const budgeted = await readBodyTextWithinBudget(
        mcpResponse,
        MAX_PROXY_RESPONSE_BODY_BYTES,
        {
          signal: hop.signal,
          onCancelFailure: (label, cancelError) => {
            // error-policy:J6 best-effort teardown for a body already rejected.
            logger.warn("[MCP Proxy] Failed to cancel oversized MCP response", {
              mcpId,
              label,
              errorType:
                cancelError instanceof Error ? cancelError.name : "unknown",
            });
          },
        },
      );
      if (!budgeted.ok) {
        if (budgeted.reason === "deadline") {
          return await refundDeadline();
        }
        logger.warn("[MCP Proxy] MCP response exceeded the proxy byte budget", {
          mcpId,
          status: mcpResponse.status,
          receivedBytes: budgeted.bytes,
          maxBytes: MAX_PROXY_RESPONSE_BODY_BYTES,
        });
        await refundPrecharge("mcp_response_too_large", {
          status: mcpResponse.status,
          maxBytes: MAX_PROXY_RESPONSE_BODY_BYTES,
        });
        return c.json({ error: "MCP response is too large" }, 502);
      }
      responseBody = budgeted.text;
    } catch (error) {
      // error-policy:J1 hop abort maps to a 504 refund; other failures stay 502.
      if (isMcpProxyHopDeadline(hop.signal, error) || hop.signal.aborted) {
        return await refundDeadline();
      }
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

    // A 2xx transport does NOT mean the tool call succeeded: MCP speaks JSON-RPC
    // 2.0, so a failed call is delivered as HTTP 200 with an `{ error: {...} }`
    // envelope. Billing on `mcpResponse.ok` alone charged the caller for a call
    // the MCP never completed (#11637 at the HTTP layer, still open at the RPC
    // layer). Refund on an explicit JSON-RPC error instead of success-shaping it.
    const rpcErrored = mcpResponse.ok && isJsonRpcErrorResponse(responseBody);
    if (mcpResponse.ok && !rpcErrored) {
      await userMcpsService
        .recordUsageWithoutDeduction({
          mcpId: mcp.id,
          organizationId: user.organization_id,
          userId: user.id,
          toolName,
          creditsCharged: creditsRequired,
          affiliateFeeCredits,
          platformFeeCredits,
          chargeReceipt,
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
        // error-policy:J7 usage recording is diagnostic and runs after the proxied
        // call already succeeded and settled; a failed write is logged, not fatal.
        .catch((usageError: Error | string) => {
          logger.error("[MCP Proxy] Failed to record usage", {
            mcpId,
            error:
              typeof usageError === "string" ? usageError : usageError.message,
          });
        });
    } else if (rpcErrored) {
      // Protocol-level failure over a 2xx transport: refund and do not bill. The
      // caller still receives the MCP's error envelope verbatim below.
      logger.warn(
        "[MCP Proxy] MCP returned a JSON-RPC error over 2xx; refunding",
        {
          mcpId,
          status: mcpResponse.status,
          toolName,
        },
      );
      await refundPrecharge("mcp_jsonrpc_error", {
        status: mcpResponse.status,
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
  } finally {
    hop.clear();
  }
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
