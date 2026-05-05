/**
 * Shared Cron Authentication Helper
 *
 * Centralizes cron auth logic to ensure consistent, fail-closed behavior:
 * - Returns 503 if CRON_SECRET is not configured (fail-safe)
 * - Uses timing-safe comparison to prevent timing attacks
 * - Returns a Response on auth failure, or null on success
 */

import { timingSafeEqual } from "crypto";
import { logger } from "@/lib/utils/logger";

interface CronSecretEnv {
  CRON_SECRET?: string | null;
}

/**
 * Verify the CRON_SECRET from the request Authorization header.
 *
 * @param request - The incoming request
 * @param logPrefix - Prefix for log messages (e.g., "[Container Billing]")
 * @returns null if auth succeeds, Response error otherwise
 */
export function verifyCronSecret(
  request: Request,
  logPrefix: string = "[Cron]",
  env?: CronSecretEnv,
): Response | null {
  const cronSecret = env?.CRON_SECRET ?? process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.warn(`${logPrefix} CRON_SECRET not configured`);
    return Response.json(
      { error: "Server configuration error: CRON_SECRET not set" },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get("authorization");
  const providedSecret =
    authHeader?.replace(/^Bearer\s+/i, "") || request.headers.get("x-cron-secret") || "";

  const expectedBuffer = Buffer.from(cronSecret, "utf8");
  const providedBuffer = Buffer.from(providedSecret, "utf8");

  const isValid =
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer);

  if (!isValid) {
    logger.warn(`${logPrefix} Unauthorized cron request`, {
      ip: request.headers.get("x-forwarded-for"),
    });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
