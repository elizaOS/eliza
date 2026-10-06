/**
 * DexScreener public API proxy — GET only, `/latest/*` paths.
 */

import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import { failureResponse } from "../../api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "../../auth/workers-hono-auth";
import { logger } from "../../utils/logger";
import {
  isAllowanceFirstOrganization,
  reserveSubscriptionFundedCredits,
  subscriptionFundingOperationKey,
} from "../allowance-first-credits";
import { creditsService, InsufficientCreditsError } from "../credits";
import { getServiceMethodCost } from "./pricing";

const UPSTREAM_ORIGIN = "https://api.dexscreener.com";
const UPSTREAM_TIMEOUT_MS = 10_000;

interface DexscreenerCharge {
  /** Returns the prepaid request cost after the free upstream failed. */
  release(reason: string, status?: number): Promise<void>;
  /** Confirms the prepaid cost after a successful upstream response. */
  confirm(): Promise<void>;
}

/**
 * Prepays one request. Subscribers hold allowance first and settle it on the
 * outcome; everyone else keeps the deduct-then-refund cash lane.
 */
async function prepayDexscreenerRequest(
  organizationId: string,
  cost: number,
  pathStr: string,
): Promise<DexscreenerCharge | null> {
  const metadata = {
    type: "proxy_dexscreener",
    service: "dexscreener",
    method: "getRequest",
    path: pathStr,
  };
  if (cost > 0 && (await isAllowanceFirstOrganization(organizationId))) {
    let reservation: Awaited<ReturnType<typeof reserveSubscriptionFundedCredits>>;
    try {
      reservation = await reserveSubscriptionFundedCredits({
        organizationId,
        operation: "search",
        logicalOperationId: await subscriptionFundingOperationKey("search:", crypto.randomUUID()),
        amount: cost,
        description: "API proxy: dexscreener — getRequest",
        metadata,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) return null;
      throw error;
    }
    return {
      release: async () => {
        await reservation.reconcile(0);
      },
      confirm: async () => {
        await reservation.reconcile(cost);
      },
    };
  }
  const deductResult = await creditsService.deductCredits({
    organizationId,
    amount: cost,
    description: "API proxy: dexscreener — getRequest",
    metadata,
  });
  if (!deductResult.success) return null;
  return {
    release: async (reason, status) => {
      await creditsService.refundCredits({
        organizationId,
        amount: cost,
        description: `API proxy refund: dexscreener — getRequest (upstream ${status ?? reason})`,
        metadata: {
          type: "proxy_dexscreener_refund",
          service: "dexscreener",
          method: "getRequest",
          path: pathStr,
          ...(status === undefined ? { reason: `upstream ${reason}` } : {}),
        },
      });
    },
    confirm: async () => {},
  };
}

/** DexScreener open endpoints are under `latest/` — keep allowlist tight. */
function isAllowedDexPath(pathStr: string): boolean {
  return pathStr.startsWith("latest/");
}

export async function handleDexscreenerProxyGet(c: Context<AppEnv>): Promise<Response> {
  try {
    const pathStr = (c.req.param("*") ?? "").replace(/^\/+|\/+$/g, "");
    if (!isAllowedDexPath(pathStr)) {
      return c.json(
        {
          error: "DexScreener proxy only serves paths under latest/",
          supportedPrefix: "latest/",
        },
        400,
      );
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const cost = await getServiceMethodCost("dexscreener", "getRequest");
    const charge = await prepayDexscreenerRequest(organization_id, cost, pathStr);

    if (!charge) {
      return c.json(
        {
          error: "Insufficient credits",
          topUpUrl: "https://cloud.eliza.app/cloud/billing",
        },
        402,
      );
    }

    const upstreamUrl = new URL(`${UPSTREAM_ORIGIN}/${pathStr}`);
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      upstreamUrl.searchParams.set(key, value);
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstreamResponse: Response;
    let body: string;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": c.req.header("User-Agent") ?? "ElizaCloud-DexScreener-Proxy/1.0",
        },
        signal: controller.signal,
      });
      body = await upstreamResponse.text();
    } catch (error) {
      // error-policy:J1 upstream boundary — translate transport and deadline
      // failures after refunding the prepaid request cost.
      const isAbort = error instanceof Error && error.name === "AbortError";
      await charge.release(isAbort ? "timeout" : "transport failure").catch((refundError) => {
        // error-policy:J4 the upstream request is already a visible failure;
        // preserve it while recording the secondary refund fault.
        logger.warn("[DexscreenerProxy] refund after upstream failure failed", {
          error: refundError instanceof Error ? refundError.message : String(refundError),
        });
      });
      if (isAbort) return c.json({ error: "Upstream service timeout" }, 504);
      return c.json({ error: "Upstream service unavailable" }, 502);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstreamResponse.ok) {
      logger.warn("[DexscreenerProxy] upstream non-OK", {
        status: upstreamResponse.status,
        path: pathStr,
      });
      // DexScreener is a FREE upstream, so a non-ok response cost us nothing —
      // refund the upfront charge so the customer isn't billed for a failed call
      // (matches the engine routes' refund-on-failure policy).
      await charge.release("non-OK", upstreamResponse.status).catch((refundError) => {
        logger.warn("[DexscreenerProxy] refund after upstream failure failed", {
          status: upstreamResponse.status,
          error: refundError instanceof Error ? refundError.message : String(refundError),
        });
      });
    } else {
      await charge.confirm();
    }

    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    // error-policy:J1 outermost route boundary — translate any thrown error
    // (auth, pricing lookup, fetch/transport) into a structured client failure
    // response; never fabricates a success/empty result from the failure.
    return failureResponse(c, error);
  }
}
