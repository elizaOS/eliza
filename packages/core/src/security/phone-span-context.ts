/**
 * Where a phone-shaped digit run is a map coordinate, not a phone number.
 *
 * The phone pattern (`\d{3}[ .-]\d{3}[ .-]?\d{4}`) also matches a longitude
 * such as `-122.4194093` ("122" "." "419" "4093"). On a Pixel (v613) a
 * `[MAPSCARD]` payload in chat history reached the planner as
 * `"longitude":-__ELIZA_CONTACT_<nonce>_34__`: the model saw every latitude
 * but no longitude, and the coordinate became a contact reference that could
 * be restored into a call or text recipient. A coordinate is never a contact.
 *
 * Dependency-free so the browser-safe entity recognizer can share it.
 */

// A Maps chat card: `[MAPSCARD]\n{json}\n[/MAPSCARD]` (plugin-maps card.ts
// serializes the JSON object whole on the line after the marker). The region
// is the marker and that one complete JSON line only: a literal, unclosed or
// truncated `[MAPSCARD]` must never exempt the owner's later words ("call
// 415-555-0100") from swapping. A coordinate anywhere else is still caught
// by its key or its geographic shape below.
const MAPS_CARD =
	/\[[ \t]*MAPSCARD[ \t]*\][ \t]*\r?\n[ \t]*\{[^\n]*\}[ \t]*(?=\r?\n|$)(?:\r?\n[ \t]*\[[ \t]*\/[ \t]*MAPSCARD[ \t]*\])?/g;

// A coordinate key just before the value: `"longitude": -`, `lng=`, `\"lat\":`.
const COORDINATE_KEY_BEFORE =
	/(?:^|[^\p{L}\p{N}_])(?:lat|lng|lon|long|latitude|longitude)\\?["']?\s*[:=]\s*\\?["']?\s*[-+]?\s*$/iu;

// Words that put a nearby decimal in a geographic context.
const GEO_CONTEXT =
	/(?:^|[^\p{L}])(?:lat|lng|lon|latitude|longitude|coordinates?|coords?|geo(?:json|location)?|bbox|bounds|center|centre|location|waypoints?|polyline)(?![\p{L}])/iu;
// How far before a decimal a geographic word still counts.
const GEO_CONTEXT_WINDOW = 160;

// A single decimal number with at least four fractional digits: "122.4194093".
// A phone written with dots has two of them ("415.555.0100").
const COORDINATE_DECIMAL = /^\d{1,3}\.\d{4,}$/;

/** The character ranges of every Maps chat card in `text`. */
function mapsCardRegions(text: string): Array<[number, number]> {
	if (!/MAPSCARD/i.test(text)) return [];
	const regions: Array<[number, number]> = [];
	MAPS_CARD.lastIndex = 0;
	for (const match of text.matchAll(MAPS_CARD)) {
		const start = match.index ?? 0;
		regions.push([start, start + match[0].length]);
		if (match[0].length === 0) break;
	}
	return regions;
}

/**
 * A predicate over `[start, end)` spans of `text` that is true when the span
 * is a map coordinate: inside a Maps chat card, the value of a latitude or
 * longitude key, or a 4+ fractional-digit decimal in a geographic context
 * (a nearby coordinate word, a sign, or the other half of a coordinate pair).
 */
export function coordinateSpanTest(
	text: string,
): (start: number, end: number) => boolean {
	const cards = mapsCardRegions(text);
	return (start, end) => {
		if (cards.some(([from, to]) => start >= from && end <= to)) return true;
		const before = text.slice(Math.max(0, start - 48), start);
		if (COORDINATE_KEY_BEFORE.test(before)) return true;
		const value = text.slice(start, end).trim();
		if (!COORDINATE_DECIMAL.test(value)) return false;
		const prefix = text.slice(Math.max(0, start - GEO_CONTEXT_WINDOW), start);
		return (
			// "-122.4194093": a phone number is never negative.
			/-\s*$/.test(prefix) ||
			// "37.7749295, 122.4194093": the second half of a coordinate pair.
			/\d\.\d{4,}\s*[,;/]\s*[-+]?\s*$/.test(prefix) ||
			// "122.4194093, 37.7749295": the first half.
			/^\s*[,;/]\s*[-+]?\d{1,3}\.\d{4,}/.test(text.slice(end, end + 24)) ||
			GEO_CONTEXT.test(prefix)
		);
	};
}
