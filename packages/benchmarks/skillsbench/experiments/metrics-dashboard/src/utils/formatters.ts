export function formatDuration(ms: number): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '-';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '-';
  return `$${usd.toFixed(4)}`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return '-';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

export function formatPercent(value: number): string {
  if (value === null || value === undefined || isNaN(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function calculateDurationMs(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}
