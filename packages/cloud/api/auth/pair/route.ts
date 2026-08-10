/**
 * Exchanges one-time agent pairing tokens for browser and native clients.
 *
 * Browser requests remain Origin-bound. Native requests require Cloud auth and
 * bind consumption to the tenant, agent, and minted origin before returning
 * the agent's API credential.
 */

import {
  type CloudPairExchangeResponse,
  isCloudPairAgentId,
} from "@elizaos/shared/contracts";
import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { AuthenticationError, errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getPairingTokenService } from "@/lib/services/pairing-token";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

const NATIVE_PAIRING_ERROR_CODE = {
  cloudAuthRequired: "cloud_auth_required",
  invalidRequest: "invalid_native_pairing_request",
  pairingTokenInvalid: "pairing_token_invalid",
  sandboxCredentialUnavailable: "sandbox_credential_unavailable",
} as const;

function nativePairingError(
  error: string,
  code: (typeof NATIVE_PAIRING_ERROR_CODE)[keyof typeof NATIVE_PAIRING_ERROR_CODE],
) {
  return { success: false as const, error, code };
}

function isPlausiblePairingToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    // error-policy:J3 untrusted client origins that cannot parse are invalid
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

app.post("/", async (c) => {
  try {
    // error-policy:J3 malformed JSON is expected client input; the null
    // sentinel maps it to the route's existing 400 validation response.
    const body: unknown = await c.req.json().catch(() => null);
    const token =
      isRecord(body) && typeof body.token === "string" ? body.token : undefined;

    if (!token) {
      return c.json({ error: "Pairing code required" }, 400);
    }

    const origin = c.req.header("origin") ?? null;
    if (!origin) {
      return c.json({ error: "Origin header required" }, 400);
    }

    if (!isPlausiblePairingToken(token)) {
      return c.json({ error: "Invalid or expired pairing code" }, 401);
    }

    const tokenService = getPairingTokenService();
    const pairingToken = await tokenService.validateToken(token, origin);
    if (!pairingToken) {
      return c.json({ error: "Invalid or expired pairing code" }, 401);
    }

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      pairingToken.agentId,
      pairingToken.orgId,
    );
    if (!sandbox) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const envVars = (sandbox.environment_vars ?? {}) as Record<string, string>;
    const apiKey = envVars.ELIZA_API_TOKEN || null;

    const response: CloudPairExchangeResponse = {
      message: "Paired successfully",
      apiKey,
      agentName: sandbox.agent_name ?? "Agent",
      agentId: pairingToken.agentId,
    };
    return c.json(response, 200, {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
  } catch (err) {
    // error-policy:J1 public route boundary returns a generic failure while
    // retaining the dependency error in structured server logs.
    logger.error("[auth/pair] error", { error: err });
    return c.json({ error: "Pairing failed" }, 500);
  }
});

/**
 * Authenticated native pairing exchange.
 *
 * Capacitor's in-process fetch may omit Origin, so this route never relaxes
 * the public browser exchange above. Instead it requires an explicit Cloud
 * bearer and atomically binds consumption to that user, organization, agent,
 * and the exact dedicated-agent origin returned by the authenticated mint.
 */
app.post("/native", async (c) => {
  try {
    const authorization = c.req.header("authorization");
    const hasCompetingCredential = [
      "x-api-key",
      "x-wallet-address",
      "x-wallet-signature",
      "x-timestamp",
    ].some((name) => Boolean(c.req.header(name)?.trim()));
    if (
      !authorization?.startsWith("Bearer ") ||
      !authorization.slice("Bearer ".length).trim() ||
      hasCompetingCredential
    ) {
      return c.json(
        nativePairingError(
          "Cloud authentication required",
          NATIVE_PAIRING_ERROR_CODE.cloudAuthRequired,
        ),
        401,
      );
    }

    const auth = await requireAuthOrApiKeyWithOrg(c.req.raw);
    if (auth.authMethod !== "session" && auth.authMethod !== "api_key") {
      return c.json(
        nativePairingError(
          "Cloud authentication required",
          NATIVE_PAIRING_ERROR_CODE.cloudAuthRequired,
        ),
        401,
      );
    }
    c.set("user", auth.user);
    c.set("authMethod", auth.authMethod);

    // error-policy:J3 malformed JSON is expected client input; the null
    // sentinel maps it to the explicit 400 native-request response below.
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) {
      return c.json(
        nativePairingError(
          "Invalid native pairing request",
          NATIVE_PAIRING_ERROR_CODE.invalidRequest,
        ),
        400,
      );
    }

    const token = typeof body.token === "string" ? body.token.trim() : "";
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const expectedOrigin =
      typeof body.expectedOrigin === "string"
        ? normalizeHttpOrigin(body.expectedOrigin.trim())
        : null;

    if (
      !isPlausiblePairingToken(token) ||
      !isCloudPairAgentId(agentId) ||
      !expectedOrigin
    ) {
      return c.json(
        nativePairingError(
          "Invalid native pairing request",
          NATIVE_PAIRING_ERROR_CODE.invalidRequest,
        ),
        400,
      );
    }

    const tokenService = getPairingTokenService();
    const claim = await tokenService.claimAuthenticatedNativeToken(token, {
      userId: auth.user.id,
      orgId: auth.user.organization_id,
      agentId,
      expectedOrigin,
    });
    if (claim.status === "sandbox-credential-unavailable") {
      logger.error("[auth/pair/native] sandbox API token unavailable", {
        agentId,
        organizationId: auth.user.organization_id,
      });
      return c.json(
        nativePairingError(
          "Pairing failed",
          NATIVE_PAIRING_ERROR_CODE.sandboxCredentialUnavailable,
        ),
        503,
      );
    }
    if (claim.status === "invalid") {
      return c.json(
        nativePairingError(
          "Invalid or expired pairing code",
          NATIVE_PAIRING_ERROR_CODE.pairingTokenInvalid,
        ),
        410,
      );
    }

    return c.json(
      {
        message: "Paired successfully",
        apiKey: claim.apiKey,
        agentName: claim.agentName ?? "Agent",
      },
      200,
      { "Cache-Control": "no-store, no-cache, must-revalidate" },
    );
  } catch (err) {
    // error-policy:J1 route boundary — translate authentication and dependency
    // failures into structured HTTP errors without exposing token context.
    logger.error("[auth/pair/native] error", { error: err });
    if (err instanceof AuthenticationError) {
      return c.json(
        nativePairingError(
          "Cloud authentication required",
          NATIVE_PAIRING_ERROR_CODE.cloudAuthRequired,
        ),
        401,
      );
    }
    return errorToResponse(err);
  }
});

export default app;
