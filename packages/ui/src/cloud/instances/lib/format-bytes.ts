/**
 * Local byte-size formatter for the Instances backups panel.
 *
 * The cloud-frontend original imported `formatByteSize` from
 * `@elizaos/shared/utils/format`, but `@elizaos/shared` does not export the
 * `./utils/*` subpath and `@elizaos/ui` deliberately avoids pulling the shared
 * server bundle. This ports the same logic locally (matching the
 * `monetization/lib/format-usd.ts` "port the helper rather than add a
 * dependency" pattern in the sibling cloud domains).
 */

interface ByteSizeOptions {
  /** Fallback string for invalid / negative byte values. */
  unknownLabel?: string;
  /** Decimal precision applied to KB / MB / GB / TB units. */
  precision?: number;
}

export function formatByteSize(
  bytes: number | null | undefined,
  options: ByteSizeOptions = {},
): string {
  const { unknownLabel = "unknown", precision = 1 } = options;

  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return unknownLabel;
  }
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(precision)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(precision)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(precision)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(precision)} KB`;
  return `${bytes} B`;
}
