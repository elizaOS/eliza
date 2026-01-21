import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";

interface RelayResult {
  forwarded: boolean;
  status?: number;
  error?: string;
}

/**
 * Conditionally relay cron execution to staging environment.
 * Enabled when REDIRECT_CRON_STAGING=true and host is not already staging.
 *
 * Note: Accepts NextRequest-compatible objects to handle version mismatches
 * between different Next.js versions in the monorepo.
 */
export async function relayCronToStaging(
  request: NextRequest | { url: string; headers: Headers },
  routeName: string,
): Promise<RelayResult> {
  if (process.env.REDIRECT_CRON_STAGING !== "true") {
    return { forwarded: false };
  }

  const stagingBaseUrl =
    process.env.CRON_STAGING_URL || "https://staging.polyagent.market";
  const stagingHost = stagingBaseUrl.replace(/^https?:\/\//, "");
  // Access headers safely - handle both NextRequest and plain Headers objects
  const headers = request.headers as
    | Headers
    | { get: (key: string) => string | null };
  const requestHost = headers?.get("host") || "";

  // Avoid infinite loops when request already targets staging
  if (requestHost === stagingHost) {
    return { forwarded: false };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.warn(
      "Cannot relay cron - CRON_SECRET missing",
      { routeName },
      "CronRelay",
    );
    return { forwarded: false };
  }

  const { pathname, search } = new URL(request.url);
  const targetUrl = `${stagingBaseUrl}${pathname}${search}`;

  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "x-cron-relay": routeName,
    },
    cache: "no-store",
  });

  logger.info(
    "Relayed cron execution to staging",
    {
      routeName,
      targetUrl,
      status: res.status,
    },
    "CronRelay",
  );

  return { forwarded: true, status: res.status };
}
