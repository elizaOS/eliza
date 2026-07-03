/**
 * Browser-safe Steward configuration.
 *
 * Vite only exposes client env vars through literal `import.meta.env.*` reads.
 * Keep these as explicit property accesses so production bundles can inline the
 * staging tenant instead of falling back to the prod default.
 */

export const DEFAULT_STEWARD_TENANT_ID = "elizacloud";

function configuredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();
  if (
    normalized.includes("your_steward_") ||
    normalized.includes("your-steward-") ||
    normalized.includes("replace_with") ||
    normalized.includes("placeholder")
  ) {
    return undefined;
  }
  return trimmed;
}

export function configuredStewardTenantId(fallback: string): string;
export function configuredStewardTenantId(
  fallback?: string,
): string | undefined;
export function configuredStewardTenantId(
  fallback?: string,
): string | undefined {
  return (
    configuredValue(import.meta.env?.VITE_STEWARD_TENANT_ID) ??
    configuredValue(import.meta.env?.NEXT_PUBLIC_STEWARD_TENANT_ID) ??
    configuredValue(
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_STEWARD_TENANT_ID
        : undefined,
    ) ??
    configuredValue(fallback)
  );
}

export function configuredStewardApiUrlOverride(): string | undefined {
  return (
    configuredValue(import.meta.env?.VITE_STEWARD_API_URL) ??
    configuredValue(import.meta.env?.NEXT_PUBLIC_STEWARD_API_URL) ??
    configuredValue(
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_STEWARD_API_URL
        : undefined,
    )
  );
}
