import {
	tailWellFormed,
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed";

/**
 * Mask a secret value for display.
 */
export function maskSecretValue(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	if (wellFormed.length <= 8) {
		return "****";
	}

	const visibleStart = truncateWellFormed(wellFormed, 4);
	const visibleEnd = tailWellFormed(wellFormed, 4);
	const maskedLength = Math.min(wellFormed.length - 8, 20);
	const mask = "*".repeat(maskedLength);

	return `${visibleStart}${mask}${visibleEnd}`;
}
