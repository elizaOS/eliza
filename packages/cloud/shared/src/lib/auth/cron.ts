/**
 * Shared cron authentication helper.
 */

import { timingSafeEqual } from "crypto";
import { logger } from "../utils/logger";

interface CronSecretEnv {
  CRON_SECRET?: string | null;
}

/**
 * Constant-time comparison of a provided secret against the expected secret.
 * Returns false on any length mismatch. Always use this (never `===`/`!==`)
 * when checking a secret/token so response timing can't leak the value
 * byte-by-byte.
 */
export function timingSafeEqualSecret(provided: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

/**
 * Verify the CRON_SECRET from the request Authorization header.
 *
 * @returns null if auth succeeds, Response error otherwise.
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

  const isValid = timingSafeEqualSecret(providedSecret, cronSecret);

  if (!isValid) {
    logger.warn(`${logPrefix} Unauthorized cron request`, {
      ip: request.headers.get("x-forwarded-for"),
    });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
