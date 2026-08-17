/**
 * Resolves the backend identity available before the renderer bundle mounts.
 * Packaged desktop HTML writes the typed boot-config slot, while older hosts
 * may still provide one of the legacy window globals.
 */

export function resolveInjectedAppApiBase(options: {
  legacyApiBase?: string;
  brandedApiBase?: unknown;
  bootApiBase?: string;
}): string | undefined {
  const brandedApiBase =
    typeof options.brandedApiBase === "string"
      ? options.brandedApiBase
      : undefined;
  const bootApiBase = options.bootApiBase?.trim();
  return options.legacyApiBase ?? brandedApiBase ?? (bootApiBase || undefined);
}
