/**
 * Launch-time availability of account-security capabilities that still belong
 * to production MFA/session/audit/export work (#22873). Until those ship, the
 * Security route must not present them as peer-level operational rows.
 */

export const ACCOUNT_SECURITY_CAPABILITY_KEYS = [
  "sessions",
  "mfa",
  "auditLog",
  "dataExport",
] as const;

export type AccountSecurityCapability =
  (typeof ACCOUNT_SECURITY_CAPABILITY_KEYS)[number];

export type AccountSecurityCapabilities = Record<
  AccountSecurityCapability,
  boolean
>;

/** Default launch state: none of the four roadmap capabilities are live. */
export const DEFAULT_ACCOUNT_SECURITY_CAPABILITIES: AccountSecurityCapabilities =
  {
    sessions: false,
    mfa: false,
    auditLog: false,
    dataExport: false,
  };

export const ACCOUNT_SECURITY_CAPABILITY_LABELS: Record<
  AccountSecurityCapability,
  string
> = {
  sessions: "session inventory",
  mfa: "two-factor authentication",
  auditLog: "audit-log reading",
  dataExport: "data export",
};

export function listUnavailableAccountSecurityCapabilities(
  capabilities: AccountSecurityCapabilities,
): AccountSecurityCapability[] {
  return ACCOUNT_SECURITY_CAPABILITY_KEYS.filter((key) => !capabilities[key]);
}

export function formatCapabilityList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
