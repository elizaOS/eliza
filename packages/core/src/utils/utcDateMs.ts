/**
 * UTC timestamp from calendar parts — uses setUTCFullYear so years 0-99 keep
 * their literal meaning (0000, 0005 … 0099) instead of Date.UTC's 1900-1999
 * remapping. Lightweight, no heavy deps, so consumers like LifeOps can import
 * without pulling provider-integrations → @noble/hashes.
 */

export function utcDateMs(
	year: number,
	monthIndex: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
	ms = 0,
): number {
	const d = new Date(0);
	d.setUTCFullYear(year, monthIndex, day);
	d.setUTCHours(hour, minute, second, ms);
	return d.getTime();
}
