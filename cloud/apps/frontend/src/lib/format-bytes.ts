interface FormatBytesOptions {
  precision?: number;
  nullFallback?: string;
}

export function formatBytes(
  bytes: number | null | undefined,
  options: FormatBytesOptions = {},
): string {
  const { precision = 2, nullFallback = "—" } = options;
  if (bytes == null || Number.isNaN(bytes)) return nullFallback;
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unitIndex).toFixed(precision)} ${units[unitIndex]}`;
}
