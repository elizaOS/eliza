/**
 * DexScreener public API proxy — GET only, `/latest/*` paths.
 */

import type { Context } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const UPSTREAM_ORIGIN = "https://api.dexscreener.com";

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
    const deductResult = await creditsService
      .deductCredits({
        organizationId: organization_id,
        amount: cost,
        description: "API proxy: dexscreener — getRequest",
        metadata: {
          type: "proxy_dexscreener",
          service: "dexscreener",
          method: "getRequest",
          path: pathStr,
        },
      })
      .catch(() => null);

    if (deductResult === null || !deductResult.success) {
      return c.json(
        {
          error: "Insufficient credits",
          topUpUrl: "https://www.elizacloud.ai/dashboard/billing",
        },
        402,
      );
    }

    const upstreamUrl = new URL(`${UPSTREAM_ORIGIN}/${pathStr}`);
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      upstreamUrl.searchParams.set(key, value);
    });

    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": c.req.header("User-Agent") ?? "ElizaCloud-DexScreener-Proxy/1.0",
      },
    });

    const body = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      logger.warn("[DexscreenerProxy] upstream non-OK", {
        status: upstreamResponse.status,
        path: pathStr,
      });
    }

    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
}
