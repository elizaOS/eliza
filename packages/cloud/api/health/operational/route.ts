/**
 * GET /api/health/operational
 *
 * Operational health check for monitoring. Returns boolean flags for the
 * subsystems whose silent misconfiguration would degrade or break the
 * monetization / payout / sandbox flows. No sensitive data (balances, keys,
 * wallet addresses) is exposed — that surface stays on the user-facing
 * `/api/v1/redemptions/status` (existing) and the admin endpoints.
 *
 * Intended caller: uptime monitors, ops dashboards, on-call runbooks.
 * Lightweight (no live RPC calls), unauthed.
 *
 * `status` flips from `ok` to `degraded` when any required-for-production
 * check fails so a single boolean grep is enough for alerts.
 */

import { Hono } from "hono";
import {
  evaluateKmsPreflight,
  type KmsBackendClass,
} from "@/api-app/services/kms-preflight";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { isStewardPlatformConfigured } from "@/lib/services/steward-platform-users";
import type { AppEnv } from "@/types/cloud-worker-env";

interface CheckResult {
  configured: boolean;
  message: string;
}

interface KmsCheckResult {
  /**
   * The KMS backend CLASS the crypto factory resolves to for this isolate.
   * NEVER key material — only the backend name, so a deploy verifier can assert
   * a deployed environment did not silently fall back to the ephemeral
   * `memory` backend (#15310).
   */
  backend: KmsBackendClass;
  /** `false` when a deployed environment resolved the ephemeral `memory` backend. */
  durable: boolean;
  message: string;
}

interface PayoutCheckResult {
  evm_configured: boolean;
  solana_configured: boolean;
  message: string;
}

const app = new Hono<AppEnv>();

app.get("/", (c) => {
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

    // KMS backend CLASS (never key material). Surfaces which crypto backend the
    // factory resolves to so a deploy verifier can assert a deployed
    // environment did not silently fall back to the ephemeral `memory` backend
    // (#15310: staging ran memory KMS and orphaned every org DEK on restart).
    // Pure: reads only env, instantiates no adapters, touches no key material.
    const kmsPreflight = evaluateKmsPreflight(env);
    const kms: KmsCheckResult = {
      backend: kmsPreflight.backend,
      durable: kmsPreflight.durable,
      message: kmsPreflight.durable
        ? `KMS backend '${kmsPreflight.backend}' is durable and resolves to a usable client for this environment`
        : `KMS backend '${kmsPreflight.backend}' is NOT durable: ${kmsPreflight.reason ?? "backend does not resolve to a usable client"}. Encrypted records will be lost or crypto writes will 500. Set ELIZA_KMS_BACKEND=local with a persistent base64 32-byte ELIZA_LOCAL_ROOT_KEY (or configure steward) and redeploy.`,
    };

    const allOk =
      steward.configured &&
      (evmConfigured || solanaConfigured) &&
      crons.configured &&
      kms.durable;

    return c.json(
      {
        status: allOk ? "ok" : "degraded",
        timestamp: Date.now(),
        region: (env as { CF_REGION?: string }).CF_REGION ?? "unknown",
        checks: {
          steward_platform: steward,
          payouts,
          crons,
          kms,
        },
      },
      200,
      { "Cache-Control": "no-store, max-age=0" },
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
