/**
 * Stub mirror of @elizaos/app-core/config/allowed-hosts. Used by
 * capacitor.config.ts to merge env-driven hosts into Capacitor's
 * allowNavigation list.
 */

export interface AllowedHostPattern {
  readonly host: string;
  readonly includeSubdomains: boolean;
}

export function parseAllowedHostEnv(
  value: string | undefined,
): AllowedHostPattern[];
export function toViteAllowedHosts(
  entries: readonly AllowedHostPattern[],
): string[];
export function toCapacitorAllowNavigation(
  entries: readonly AllowedHostPattern[],
): string[];
