import { toWellFormedUnicode, truncateWellFormed } from "../../../utils/well-formed";

/**
 * Mask a secret value for display.
 */
export function maskSecretValue(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	if (wellFormed.length <= 8) {
		return "****";
	}

	const visibleStart = truncateWellFormed(wellFormed, 4);
	let endCut = wellFormed.length - 4;
	const code = wellFormed.charCodeAt(endCut);
	if (code >= 0xdc00 && code <= 0xdfff) {
		endCut += 1;
	}
	const visibleEnd = wellFormed.slice(endCut);
	const maskedLength = Math.min(wellFormed.length - 8, 20);
	const mask = "*".repeat(maskedLength);

	return `${visibleStart}${mask}${visibleEnd}`;
}
