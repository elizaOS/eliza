/** Fast stable-ish fingerprint for template / trace keys (not cryptographic). */
export function simpleHash(s: string): string {
	return s
		.split("")
		.reduce((h, c) => ((h * 31) ^ c.charCodeAt(0)) >>> 0, 5381)
		.toString(16)
		.slice(0, 8);
}
