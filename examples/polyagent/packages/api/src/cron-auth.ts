/**
 * Cron Job Authentication Utility
 *
 * @description Centralized authentication for cron job endpoints.
 * Provides consistent, secure authentication across all cron endpoints.
 *
 * Security Model:
 * - Production: FAIL-CLOSED. Requires valid CRON_SECRET.
 * - Development: Accepts env CRON_SECRET, dev credentials, or 'Bearer development'
 *
 * @example
 * ```typescript
 * import { verifyCronAuth } from '@polyagent/api';
 *
 * export async function POST(request: NextRequest) {
 *   if (!verifyCronAuth(request)) {
 *     return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *   }
 *   // ... handler logic
 * }
 * ```
 */

import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { isValidCronSecret } from "./dev-credentials";
import { AuthorizationError } from "./errors";

const isDevelopment = process.env.NODE_ENV !== "production";

interface CronAuthOptions {
  /** Name of the cron job for logging */
  jobName?: string;
  /** Allow Vercel Cron user-agent as auth (for GET endpoints) */
  allowVercelCronUserAgent?: boolean;
}

/**
 * Verify cron request authorization
 *
 * @security FAIL-CLOSED in production if CRON_SECRET is not configured.
 * In development, accepts dev credentials or 'Bearer development'.
 *
 * @param request - Next.js request object
 * @param options - Optional configuration
 * @returns true if authorized, false otherwise
 */
export function verifyCronAuth(
  request: NextRequest,
  options: CronAuthOptions = {},
): boolean {
  const { jobName = "Cron", allowVercelCronUserAgent = false } = options;
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // Check for Vercel Cron user-agent (some cron services use this)
  if (allowVercelCronUserAgent) {
    const userAgent = request.headers.get("user-agent")?.toLowerCase() || "";
    const isVercelCron = userAgent.includes("vercel-cron");
    const hasVercelHeader = request.headers.has("x-vercel-id");

    if (isVercelCron || hasVercelHeader) {
      logger.info(
        "Cron request authorized via Vercel headers",
        { userAgent, hasVercelHeader },
        jobName,
      );
      return true;
    }
  }

  // Development mode: flexible auth for smooth DX
  if (isDevelopment) {
    // No auth header at all - allow in dev for convenience
    if (!authHeader) {
      logger.info(
        "Development mode - allowing cron without auth header",
        undefined,
        jobName,
      );
      return true;
    }

    // Accept 'Bearer development' keyword in dev
    if (authHeader === "Bearer development") {
      logger.info(
        "Cron authorized via development keyword",
        undefined,
        jobName,
      );
      return true;
    }

    // Check env CRON_SECRET if configured
    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      return true;
    }

    // Check dev credentials (from dev-credentials.ts)
    const bearerToken = authHeader.replace("Bearer ", "");
    if (bearerToken && isValidCronSecret(bearerToken)) {
      logger.info("Cron authorized via dev credentials", undefined, jobName);
      return true;
    }

    // Invalid auth header provided - deny even in dev
    logger.warn(
      "Cron auth failed - invalid credentials provided",
      { hasAuthHeader: true },
      jobName,
    );
    return false;
  }

  // PRODUCTION: FAIL-CLOSED
  if (!cronSecret) {
    logger.error(
      "🚨 SECURITY: CRON_SECRET not configured in production! Denying request.",
      {
        environment: process.env.NODE_ENV,
        hasAuthHeader: !!authHeader,
      },
      jobName,
    );
    return false; // FAIL-CLOSED
  }

  // Verify the secret
  if (authHeader !== `Bearer ${cronSecret}`) {
    logger.warn(
      "Cron authentication failed - invalid or missing secret",
      { hasAuthHeader: !!authHeader },
      jobName,
    );
    return false;
  }

  return true;
}

/**
 * Require cron authorization (throws on failure)
 *
 * @throws AuthorizationError if not authorized
 */
export function requireCronAuth(
  request: NextRequest,
  options: CronAuthOptions = {},
): void {
  if (!verifyCronAuth(request, options)) {
    throw new AuthorizationError(
      "Invalid cron authorization",
      "cron",
      options.jobName || "execute",
    );
  }
}

/**
 * Create unauthorized cron response
 */
export function cronUnauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized cron request" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
