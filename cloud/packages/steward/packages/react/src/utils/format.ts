/**
 * Truncate an address for display: 0x1234...5678
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

/**
 * Format wei string to ETH with specified decimals.
 */
export function formatWei(wei: string, decimals = 4): string {
  if (!wei || wei === "0") return "0";
  const num = BigInt(wei);
  const divisor = BigInt(10 ** 18);
  const whole = num / divisor;
  const fraction = num % divisor;
  const fractionStr = fraction.toString().padStart(18, "0").slice(0, decimals);
  if (decimals === 0) return whole.toString();
  return `${whole}.${fractionStr}`;
}

/**
 * Format a wei string for currency display with symbol.
 */
export function formatBalance(wei: string, symbol = "ETH", decimals = 4): string {
  return `${formatWei(wei, decimals)} ${symbol}`;
}

/**
 * Format a Date or ISO string to a human-readable timestamp.
 */
export function formatTimestamp(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a relative time string (e.g., "2 min ago").
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatTimestamp(d);
}

/**
 * Copy text to clipboard. Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a block explorer URL for a transaction hash.
 */
export function getExplorerTxUrl(txHash: string, chainId: number): string {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io",
    56: "https://bscscan.com",
    97: "https://testnet.bscscan.com",
    137: "https://polygonscan.com",
    8453: "https://basescan.org",
    42161: "https://arbiscan.io",
    84532: "https://sepolia.basescan.org",
  };
  const base = explorers[chainId] || `https://etherscan.io`;
  return `${base}/tx/${txHash}`;
}

/**
 * Get a block explorer URL for an address.
 */
export function getExplorerAddressUrl(address: string, chainId: number): string {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io",
    56: "https://bscscan.com",
    97: "https://testnet.bscscan.com",
    137: "https://polygonscan.com",
    8453: "https://basescan.org",
    42161: "https://arbiscan.io",
    84532: "https://sepolia.basescan.org",
  };
  const base = explorers[chainId] || `https://etherscan.io`;
  return `${base}/address/${address}`;
}

/**
 * Get status badge color class.
 */
export function getStatusColor(status: string): string {
  switch (status) {
    case "confirmed":
    case "approved":
      return "stwd-badge-success";
    case "failed":
    case "rejected":
      return "stwd-badge-error";
    case "pending":
    case "broadcast":
      return "stwd-badge-warning";
    default:
      return "stwd-badge-muted";
  }
}

/**
 * Calculate percentage, clamped to 0-100.
 */
export function calcPercent(used: string, limit: string): number {
  if (!limit || limit === "0") return 0;
  const u = BigInt(used);
  const l = BigInt(limit);
  if (l === BigInt(0)) return 0;
  const pct = Number((u * BigInt(100)) / l);
  return Math.min(100, Math.max(0, pct));
}
