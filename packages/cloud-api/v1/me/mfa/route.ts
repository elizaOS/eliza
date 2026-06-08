/**
 * GET /api/v1/me/mfa
 *
 * Returns MFA enrollment status for the authenticated user by querying
 * the Steward auth provider. Steward manages passkey (WebAuthn) and
 * email-based authentication — passkeys ARE the MFA factor.
 *
 * The route proxies to Steward's `/auth/credentials` endpoint (via the
 * configured STEWARD_API_URL) to check whether the user has enrolled
 * any passkey credentials. If Steward is unreachable, falls back to
 * reporting MFA as not enrolled rather than erroring out.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

/**
 * Query Steward for passkey/credential enrollment.
 * Steward serves `/auth/credentials` which lists a user's enrolled
 * WebAuthn credentials when called with a valid session token.
 */
async function queryStewardMfaStatus(
  stewardApiUrl: string,
  authHeader: string | undefined,
  tenantId: string | undefined,
): Promise<{ enrolled: boolean; method: string | null }> {
  if (!stewardApiUrl) {
    return { enrolled: false, method: null };
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader) {
      headers.Authorization = authHeader;
    }
    if (tenantId) {
      headers["X-Steward-Tenant"] = tenantId;
    }

    const res = await fetch(`${stewardApiUrl}/auth/credentials`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      // Steward may not expose this endpoint — that's fine
      return { enrolled: false, method: null };
    }

    const data = (await res.json()) as {
      ok?: boolean;
      data?: {
        credentials?: Array<{
          id: string;
          type?: string;
          createdAt?: string;
        }>;
      };
      credentials?: Array<{ id: string; type?: string }>;
    };

    const credentials = data?.data?.credentials ?? data?.credentials ?? [];

    if (credentials.length > 0) {
      return { enrolled: true, method: "passkey" };
    }

    return { enrolled: false, method: null };
  } catch (err) {
    logger.warn("[MFA] Could not reach Steward for MFA status", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { enrolled: false, method: null };
  }
}

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    // Resolve Steward upstream URL
    const stewardApiUrl = (
      c.env.STEWARD_API_URL ||
      c.env.NEXT_PUBLIC_STEWARD_API_URL ||
      ""
    ).replace(/\/+$/, "");

    const tenantId =
      typeof c.env.STEWARD_TENANT_ID === "string"
        ? c.env.STEWARD_TENANT_ID.trim()
        : undefined;

    // Forward the user's auth header to Steward
    const authHeader = c.req.header("Authorization");

    const status = await queryStewardMfaStatus(
      stewardApiUrl,
      authHeader,
      tenantId,
    );

    return c.json(status);
  } catch (error) {
    logger.error("[MFA] Error fetching MFA status:", error);
    return failureResponse(c, error);
  }
});

export default app;
