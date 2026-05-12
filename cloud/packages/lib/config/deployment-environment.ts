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
