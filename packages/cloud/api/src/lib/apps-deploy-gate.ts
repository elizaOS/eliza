// Boots cloud API src lib apps deploy gate Worker infrastructure under Cloudflare runtime constraints.
type EnvLike = Record<string, unknown>;

export type AppsDeployGateReason =
  | "production_allowlist_missing"
  | "organization_not_allowlisted";

export interface AppsDeployTriggerDecision {
  enabled: boolean;
  reason?: "production_allowlist_missing";
}

export interface AppsDeployOrganizationDecision {
  allowed: boolean;
  reason?: AppsDeployGateReason;
}

function envString(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value.trim() : undefined;
}

export function isProductionAppsDeployEnvironment(env: EnvLike): boolean {
  const environment = envString(env, "ENVIRONMENT");
  if (environment) return environment === "production";
  return envString(env, "NODE_ENV") === "production";
}

export function parseAppsDeployAllowedOrgIds(env: EnvLike): Set<string> {
  const raw = envString(env, "APPS_DEPLOY_ALLOWED_ORG_IDS");
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function appsDeployTriggerDecision(
  env: EnvLike = process.env,
): AppsDeployTriggerDecision {
  if (envString(env, "APPS_DEPLOY_ENABLED") !== "1") {
    return { enabled: false };
  }

  if (
    isProductionAppsDeployEnvironment(env) &&
    parseAppsDeployAllowedOrgIds(env).size === 0
  ) {
    return { enabled: false, reason: "production_allowlist_missing" };
  }

  return { enabled: true };
}

export function appsDeployOrganizationDecision(
  env: EnvLike,
  organizationId: string | null | undefined,
): AppsDeployOrganizationDecision {
  if (envString(env, "APPS_DEPLOY_ENABLED") !== "1") {
    return { allowed: true };
  }

  if (!isProductionAppsDeployEnvironment(env)) {
    return { allowed: true };
  }

  const allowedOrgIds = parseAppsDeployAllowedOrgIds(env);
  if (allowedOrgIds.size === 0) {
    return { allowed: false, reason: "production_allowlist_missing" };
  }

  // "*" opens deploys to every org — the full-launch posture. Kept as an
  // explicit opt-in token (not "empty allowlist = all") so a missing/unset
  // config still fails closed: you open to everyone on purpose, never by
  // forgetting to configure the allowlist.
  if (allowedOrgIds.has("*")) {
    return { allowed: true };
  }

  if (!organizationId || !allowedOrgIds.has(organizationId)) {
    return { allowed: false, reason: "organization_not_allowlisted" };
  }

  return { allowed: true };
}
