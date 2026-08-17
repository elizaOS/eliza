/**
 * GET /api/health/operational
 *
 * Operational health check for monitoring. The public, unauthenticated
 * payload is intentionally collapsed to `{ status, timestamp }` so backend
 * configuration state (which payout/cron/Steward/OAuth subsystems are live or
 * misconfigured) is not disclosed to the internet. The per-check detail —
 * boolean flags for the subsystems whose silent misconfiguration would
 * degrade or break the monetization / payout / sandbox flows — is returned
 * only to platform admins. No sensitive data (balances, keys, wallet
 * addresses) is exposed in either variant — that surface stays on the
 * user-facing `/api/v1/redemptions/status` (existing) and the admin
 * endpoints.
 *
 * Intended caller: uptime monitors, ops dashboards, on-call runbooks.
 * Lightweight (no live RPC calls).
 *
 * `status` flips from `ok` to `degraded` when any required-for-production
 * check fails so a single boolean grep is enough for alerts.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { getProviderEnvDiagnostics } from "@/lib/services/oauth/provider-registry";
import { isStewardPlatformConfigured } from "@/lib/services/steward-platform-users";
import type { AppEnv } from "@/types/cloud-worker-env";

interface CheckResult {
  configured: boolean;
  message: string;
}

interface PayoutCheckResult {
  evm_configured: boolean;
  solana_configured: boolean;
  message: string;
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const env = getCloudAwareEnv();

    const steward: CheckResult = {
      configured: isStewardPlatformConfigured(),
      message: isStewardPlatformConfigured()
        ? "Steward platform key present"
        : "STEWARD_PLATFORM_KEYS not configured — sandbox tenant auto-provisioning falls back to default tenant",
    };

    const evmConfigured = Boolean(
      env.EVM_PAYOUT_PRIVATE_KEY ||
        env.EVM_PRIVATE_KEY ||
        env.EVM_PAYOUT_WALLET_ADDRESS,
    );
    const solanaConfigured = Boolean(env.SOLANA_PAYOUT_PRIVATE_KEY);
    const payouts: PayoutCheckResult = {
      evm_configured: evmConfigured,
      solana_configured: solanaConfigured,
      message:
        evmConfigured || solanaConfigured
          ? `Payout wallets configured (evm=${evmConfigured}, solana=${solanaConfigured})`
          : "No payout wallets configured — token redemption cron cannot execute",
    };

    const crons: CheckResult = {
      configured: Boolean(env.CRON_SECRET),
      message: env.CRON_SECRET
        ? "CRON_SECRET present"
        : "CRON_SECRET not set — scheduled jobs (container-billing, process-redemptions) cannot authenticate",
    };

    const oauthProviders = getProviderEnvDiagnostics();
    const requiredOAuthProviders = oauthProviders.filter(
      (provider) => provider.requiredForDeployment,
    );
    const missingRequiredOAuthProviders = requiredOAuthProviders.filter(
      (provider) => !provider.configured,
    );
    const oauthProvidersCheck: CheckResult = {
      configured: missingRequiredOAuthProviders.length === 0,
      message:
        missingRequiredOAuthProviders.length === 0
          ? `All ${requiredOAuthProviders.length} deployment-required OAuth providers configured`
          : `Missing deployment-required OAuth providers: ${missingRequiredOAuthProviders.map((provider) => provider.id).join(", ")}`,
    };

    const allOk =
      steward.configured &&
      (evmConfigured || solanaConfigured) &&
      crons.configured &&
      oauthProvidersCheck.configured;

    const status = allOk ? "ok" : "degraded";
    const cacheHeaders = { "Cache-Control": "no-store, max-age=0" };

    let isPlatformAdmin = false;
    try {
      await requireAdmin(c);
      isPlatformAdmin = true;
    } catch {
      // error-policy:J1 route boundary — a failed admin resolution is not an error for a health probe; the caller receives the collapsed public payload below.
    }

    if (!isPlatformAdmin) {
      return c.json({ status, timestamp: Date.now() }, 200, cacheHeaders);
    }

    return c.json(
      {
        status,
        timestamp: Date.now(),
        region: (env as { CF_REGION?: string }).CF_REGION ?? "unknown",
        checks: {
          steward_platform: steward,
          payouts,
          crons,
          oauth_providers: oauthProvidersCheck,
        },
        oauth_providers: oauthProviders,
      },
      200,
      cacheHeaders,
    );
  } catch (error) {
    // error-policy:J1 translate an operational-health boundary failure into the shared API error shape.
    return failureResponse(c, error);
  }
});

export default app;
