import { eq } from "drizzle-orm";
import type { TenantMfaPolicyConfig } from "../../../contracts/index";
import { getDb, tenantConfigs } from "../../db/index";

export async function readTenantMfaPolicy(
  tenantId: string,
): Promise<TenantMfaPolicyConfig> {
  const [row] = await getDb()
    .select({ authAbuseConfig: tenantConfigs.authAbuseConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));
  return row?.authAbuseConfig?.mfa ?? {};
}
export function tenantMfaMaxAgeMs(
  policy: TenantMfaPolicyConfig,
  action?: keyof NonNullable<TenantMfaPolicyConfig["requireFor"]>,
): number {
  const seconds = action
    ? (policy.maxAgeFor?.[action] ?? policy.maxAgeSeconds)
    : policy.maxAgeSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(30, Math.min(3600, Math.floor(seconds))) * 1000
    : 5 * 60_000;
}
export function tenantMfaRequiredFor(
  policy: TenantMfaPolicyConfig,
  action: keyof NonNullable<TenantMfaPolicyConfig["requireFor"]>,
): boolean {
  return policy.requireFor?.[action] !== false;
}
export function tenantMfaDisabledFor(
  policy: TenantMfaPolicyConfig,
  action: keyof NonNullable<TenantMfaPolicyConfig["disableFor"]>,
): boolean {
  return policy.disableFor?.[action] === true;
}
