/**
 * Utility functions for formatting DeFi news data
 */

/**
 * Format a number as currency (USD)
 */
export function formatCurrency(value: number, decimals: number = 2): string {
  // Scale on the magnitude so negative figures (price/market-cap changes) get
  // the same suffix as positive ones, and promote to the next suffix when
  // rounding reaches 1000 (999_999 → "$1.00M", not "$1000.00K").
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  const units = [
    { size: 1e12, suffix: "T" },
    { size: 1e9, suffix: "B" },
    { size: 1e6, suffix: "M" },
    { size: 1e3, suffix: "K" },
    { size: 1, suffix: "" },
  ];
  for (const [index, unit] of units.entries()) {
    if (magnitude < unit.size && unit.size !== 1) continue;
    const larger = units[index - 1];
    const rounded = (magnitude / unit.size).toFixed(decimals);
    if (larger && Number(rounded) >= 1000) {
      return `${sign}$${(magnitude / larger.size).toFixed(decimals)}${larger.suffix}`;
    }
    return `${sign}$${rounded}${unit.suffix}`;
  }
  return `${sign}$${magnitude.toFixed(decimals)}`;
}

/**
 * Format a percentage with appropriate emoji
 */
export function formatPercentage(value: number, decimals: number = 2): string {
  const emoji = value >= 0 ? "📈" : "📉";
  const sign = value >= 0 ? "+" : "";
  return `${emoji} ${sign}${value.toFixed(decimals)}%`;
}

/**
 * Format a timestamp as a human-readable date
 */
export function formatDate(timestamp: number | string): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Format a relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: number | string): string {
  const now = Date.now();
  const date = new Date(timestamp).getTime();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""} ago`;
  } else if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  } else {
    return `${seconds} second${seconds > 1 ? "s" : ""} ago`;
  }
}

/**
 * Get sentiment emoji
 */
export function getSentimentEmoji(sentiment?: string): string {
  if (!sentiment) return "😐";

  switch (sentiment.toLowerCase()) {
    case "positive":
      return "😊";
    case "negative":
      return "😟";
    case "neutral":
      return "😐";
    default:
      return "😐";
  }
}

/**
 * Format large numbers with commas
 */
export function formatNumber(value: number, decimals: number = 0): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Extract token symbol from text
 */
export function extractTokenSymbol(text: string): string | null {
  // Match 3-5 uppercase letters that might be a token symbol
  const match = text.match(/\b([A-Z]{3,5})\b/);
  return match ? match[1] : null;
}

/**
 * Format OHLCV data for display
 */
export function formatOHLCV(candle: {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}): string {
  const date = formatDate(candle.timestamp);
  let result = `📅 ${date}\n`;
  result += `   Open: ${formatCurrency(candle.open)}\n`;
  result += `   High: ${formatCurrency(candle.high)}\n`;
  result += `   Low: ${formatCurrency(candle.low)}\n`;
  result += `   Close: ${formatCurrency(candle.close)}`;
  if (candle.volume !== undefined) {
    result += `\n   Volume: ${formatCurrency(candle.volume)}`;
  }
  return result;
}

/**
 * Clean HTML tags from text
 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * Validate if a string is a valid token address
 */
export function isValidTokenAddress(address: string): boolean {
  // Ethereum address (0x followed by 40 hex characters)
  const ethRegex = /^0x[a-fA-F0-9]{40}$/;
  // Solana address (base58, 32-44 characters)
  const solRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  return ethRegex.test(address) || solRegex.test(address);
}
