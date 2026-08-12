/** Formats durations and timestamps for human-readable display. */

function describeRelativeTime(
	timestamp: number,
	style: "compact" | "verbose",
): string {
	const now = Date.now();
	const diff = now - timestamp;
	const future = diff < 0;
	const absDiff = Math.abs(diff);

	// Direction-aware rounding. Future magnitudes round UP so "in N <unit>"
	// always means the moment arrives within N units: a target computed as
	// now + 5 minutes has already lost a few milliseconds by the time this
	// function reads the clock, and flooring would render it "in 4m". Past
	// magnitudes keep the original floor, so every past-direction string is
	// unchanged. Each unit is derived from absDiff directly because
	// ceil(ceil(x/a)/b) overshoots where ceil(x/(a*b)) does not.
	const round = future ? Math.ceil : Math.floor;
	const minutes = round(absDiff / 60000);
	const hours = round(absDiff / 3600000);
	const days = round(absDiff / 86400000);

	// A magnitude ("5 minutes", "3d") carries no direction; the tense is applied
	// here. A past timestamp reads "<magnitude> ago"; a future one reads
	// "in <magnitude>". Without this split every branch fell through to "ago",
	// so a timestamp ahead of now — clock skew, a scheduled item, or a record
	// dated slightly in the future — was described as though it had already
	// happened.
	const tense = (magnitude: string): string =>
		future ? `in ${magnitude}` : `${magnitude} ago`;

	if (style === "verbose") {
		if (absDiff < 60000) {
			return "just now";
		}
		if (minutes < 60) {
			return tense(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
		}
		if (hours < 24) {
			return tense(`${hours} hour${hours !== 1 ? "s" : ""}`);
		}
		return tense(`${days} day${days !== 1 ? "s" : ""}`);
	}

	// The raw-millisecond threshold keeps compact and verbose "just now"
	// windows identical in both directions.
	if (absDiff < 60000) {
		return "just now";
	}
	if (minutes < 60) {
		return tense(`${minutes}m`);
	}
	if (hours < 24) {
		return tense(`${hours}h`);
	}
	if (days === 1) {
		return future ? "Tomorrow" : "Yesterday";
	}
	if (days < 7) {
		return tense(`${days}d`);
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
 * formatRelativeTime(Date.now() + 300000) // => "in 5m"
 * formatRelativeTime(Date.now() + 86400000) // => "Tomorrow"
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
