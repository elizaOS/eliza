/**
 * Mask a secret value for display.
 */
export function maskSecretValue(value: string): string {
	if (value.length <= 8) {
		return "****";
	}

	const visibleStart = value.slice(0, 4);
	const visibleEnd = value.slice(-4);
	const maskedLength = Math.min(value.length - 8, 20);
	const mask = "*".repeat(maskedLength);

	return `${visibleStart}${mask}${visibleEnd}`;
}
