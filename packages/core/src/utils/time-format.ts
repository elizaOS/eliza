/**
 * Time formatting utilities.
 *
 * Provides functions for human-readable time display.
 *
 * @module utils/time-format
 */

function describeRelativeTime(
	timestamp: number,
	style: "compact" | "verbose",
): string {
	const now = Date.now();
	const diff = now - timestamp;
	const absDiff = Math.abs(diff);
	const seconds = Math.floor(absDiff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (style === "verbose") {
		if (absDiff < 60000) {
			return "just now";
		}
		if (minutes < 60) {
			return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
		}
		if (hours < 24) {
			return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
		}
		return `${days} day${days !== 1 ? "s" : ""} ago`;
	}

	if (seconds < 60) {
		return "just now";
	}
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	if (hours < 24) {
		return `${hours}h ago`;
	}
	if (days === 1) {
		return "Yesterday";
	}
	if (days < 7) {
		return `${days}d ago`;
	}
	return new Date(timestamp).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

/**
 * Format a timestamp as a relative time string.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Human-readable relative time string
 *
 * @example
 * ```ts
 * formatRelativeTime(Date.now() - 30000) // => "just now"
 * formatRelativeTime(Date.now() - 300000) // => "5m ago"
 * formatRelativeTime(Date.now() - 7200000) // => "2h ago"
 * formatRelativeTime(Date.now() - 86400000) // => "Yesterday"
 * formatRelativeTime(Date.now() - 604800000) // => "Jan 15" (or similar)
 * ```
 */
export function formatRelativeTime(timestamp: number): string {
	return describeRelativeTime(timestamp, "compact");
}

/**
 * Format a timestamp as a verbose relative string.
 */
export function formatTimestamp(timestamp: number): string {
	return describeRelativeTime(timestamp, "verbose");
}
