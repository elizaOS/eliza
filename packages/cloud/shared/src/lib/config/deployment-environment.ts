// Defines cloud configuration deployment environment invariants for backend services.
type EnvLike = Record<string, string | undefined>;

/**
 * Distinguish real production deployments from staging/preview/dev. The
 * Cloudflare Workers config sets ENVIRONMENT explicitly per environment;
 * fall back to NODE_ENV when ENVIRONMENT is unset (e.g. local Node runs).
 */
export function isProductionDeployment(env: EnvLike = process.env): boolean {
  if (env.ENVIRONMENT) {
    return env.ENVIRONMENT === "production";
  }

  return env.NODE_ENV === "production";
}

export function shouldBlockUnsafeWebhookSkip(env: EnvLike = process.env): boolean {
  return env.SKIP_WEBHOOK_VERIFICATION === "true" && isProductionDeployment(env);
}

export function shouldBlockDevnetBypass(env: EnvLike = process.env): boolean {
  return env.DEVNET === "true" && isProductionDeployment(env);
}

/**
 * Block the Cloudflare registrar/DNS dev stub from running in production. The
 * stub (ELIZA_CF_REGISTRAR_DEV_STUB=1) returns fake registrations that still
 * debit credits, so a stray flag in prod charges users for domains that were
 * never registered. Dev/test/staging may keep using it.
 */
export function shouldBlockRegistrarStub(env: EnvLike = process.env): boolean {
  return env.ELIZA_CF_REGISTRAR_DEV_STUB === "1" && isProductionDeployment(env);
}

/**
 * Block payout availability from being marked operational by assertion in
 * production. This flag is useful for local/staging e2e stacks that skip live
 * hot-wallet balance reads, but in production it can accept redemption requests
 * without proving the payout wallet can actually deliver tokens.
 */
export function shouldBlockPayoutAssumeOperational(env: EnvLike = process.env): boolean {
  return env.PAYOUT_STATUS_ASSUME_OPERATIONAL === "1" && isProductionDeployment(env);
}
