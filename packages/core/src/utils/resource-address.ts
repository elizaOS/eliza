/** Syntactic address recognition only: no network probe, permission or dispatch. */
function isIPv4Literal(hostname: string): boolean {
	const octets = hostname.split(".");
	return (
		octets.length === 4 &&
		octets.every((octet) => /^\d+$/u.test(octet) && Number(octet) <= 255)
	);
}

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
	// A host:port pair is not a bare word or a version number, so an implicit
	// localhost, IPv4 literal, or IPv6 literal with an explicit port is a
	// resource too ("open localhost:3000" names a destination, not a search).
	if (!explicit && (labels.length < 2 || /^\d+$/u.test(labels.at(-1) ?? ""))) {
		// Decide the port from the authored text, not the normalized URL:
		// the URL parser strips a default port (for example `:443` on
		// `https:`), so `url.port` is empty even when the author wrote one.
		const hasExplicitPort = /^(?:\[[^\]\s]+\]|[^\s/:]+):\d+(?:[/?#].*)?$/u.test(
			text,
		);
		const isHostPortAddress =
			hasExplicitPort &&
			(url.hostname === "localhost" ||
				url.hostname.startsWith("[") ||
				isIPv4Literal(url.hostname));
		if (!isHostPortAddress) return;
	}
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
		text.split(/\s+/u).some((token) => {
			// Try the token as-is first, then with only trailing punctuation
			// removed, then fully unwrapped. Stripping a leading "[" up
			// front would mangle a bracketed IPv6 literal ("[::1]:8080"
			// loses its "["), while a trailing "." after the port
			// ("[::1]:8080.") is not a valid URL, so the raw token alone
			// is not enough.
			if (parseWebResourceAddress(token) !== undefined) return true;
			const trailingStripped = token.replace(/[)\]>"'`.,!?;]+$/gu, "");
			if (parseWebResourceAddress(trailingStripped) !== undefined) return true;
			return (
				parseWebResourceAddress(
					token.replace(/^[([<"'`]+|[)\]>"'`.,!?;]+$/gu, ""),
				) !== undefined
			);
		})
	);
}
