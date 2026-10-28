/** Syntactic address recognition only: no network probe, permission or dispatch. */
export function parseWebResourceAddress(value: string): URL | undefined {
	const text = value.trim();
	if (!text || /[\s<>"'`]/u.test(text)) return;
	const explicit = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text);
	if (explicit && !/^https?:\/\//iu.test(text)) return;
	let url: URL;
	try {
		url = new URL(explicit ? text : `https://${text}`);
	} catch {
		return;
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		return;
	const labels = url.hostname.replace(/\.$/u, "").split(".");
	// A bare word is an app/search term, not an implicit network destination.
	// Validate DNS syntax without a site or TLD allowlist. Explicit IP/localhost
	// addresses stay resources; the existing operation's policy owns eligibility.
	if (!explicit && (labels.length < 2 || /^\d+$/u.test(labels.at(-1) ?? "")))
		return;
	if (
		!url.hostname.startsWith("[") &&
		labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label))
	)
		return;
	return url;
}

/** Preserve explicit resources (including unsupported schemes) and recognize
 * bare web addresses, so choosing an app view cannot pretend to open a resource.
 */
export function containsResourceAddress(text: string): boolean {
	return (
		/\b[a-z][a-z0-9+.-]*:\/\/\S*/iu.test(text) ||
		text
			.split(/\s+/u)
			.some(
				(token) =>
					parseWebResourceAddress(
						token.replace(/^[([<"'`]+|[)\]>"'`.,!?;]+$/gu, ""),
					) !== undefined,
			)
	);
}
