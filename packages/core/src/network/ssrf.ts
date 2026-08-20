/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Provides DNS pinning and IP address validation to prevent SSRF attacks
 * when fetching external resources.
 */

export type LookupAddress = { address: string; family: number };

export type LookupCallback = (
	err: Error | null,
	address: string | LookupAddress[],
	family?: number,
) => void;

export type LookupFn = (
	hostname: string,
	options: { all: true },
) => Promise<LookupAddress[]>;

export type LookupOptions = number | { all?: boolean; family?: number };

export type PinnedLookup = {
	(hostname: string, callback: LookupCallback): void;
	(hostname: string, options: LookupOptions, callback: LookupCallback): void;
};

export class SsrfBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SsrfBlockedError";
	}
}

export type SsrfPolicy = {
	allowPrivateNetwork?: boolean;
	allowedHostnames?: string[];
};

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

export function normalizeHostLike(hostname: string): string {
	const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (normalized.startsWith("[") && normalized.endsWith("]")) {
		return normalized.slice(1, -1);
	}
	return normalized;
}

/** Return true only for localhost and literal loopback addresses. */
export function isLoopbackHost(hostname: string): boolean {
	const normalized = normalizeIpForPolicy(hostname);
	if (normalized === "localhost" || normalized === "::1") return true;

	const mapped = normalized.startsWith("::ffff:")
		? parseIpv4FromMappedIpv6(normalized.slice("::ffff:".length))
		: null;
	const ipv4 = mapped ?? parseIpv4(normalized) ?? parseIpv4Loose(normalized);
	return ipv4?.[0] === 127;
}

/** Normalize brackets, scope ids, and IPv4-mapped IPv6 forms for policy checks. */
export function normalizeIpForPolicy(address: string): string {
	const normalized = normalizeHostLike(address).split("%")[0];
	const mappedMatch = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)(.+)$/i.exec(normalized);
	if (!mappedMatch?.[1]) return normalized;
	const rawMapped = mappedMatch[1];
	const mapped = rawMapped.includes(".")
		? (parseIpv4Loose(rawMapped) ?? parseIpv4(rawMapped))
		: parseIpv4FromMappedIpv6(rawMapped);
	return mapped ? mapped.join(".") : normalized;
}

function normalizeHostnameSet(values?: string[]): Set<string> {
	if (!values || values.length === 0) {
		return new Set<string>();
	}
	return new Set(
		values.map((value) => normalizeHostLike(value)).filter(Boolean),
	);
}

function parseIpv4(address: string): number[] | null {
	const parts = address.split(".");
	if (
		parts.length !== 4 ||
		parts.some((part) => !/^(?:0|[1-9][0-9]*)$/.test(part))
	) {
		return null;
	}
	const numbers = parts.map((part) => Number.parseInt(part, 10));
	if (
		numbers.some((value) => Number.isNaN(value) || value < 0 || value > 255)
	) {
		return null;
	}
	return numbers;
}

/**
 * Parse the legacy/non-canonical IPv4 forms that the OS resolver
 * (`getaddrinfo`/`inet_aton`) accepts: octal (`0177`), hex (`0x7f`), plain
 * decimal (`2130706433`), and 1-3 part short forms (`127.1`). An SSRF guard
 * must classify these the way the resolver would actually connect, otherwise
 * `http://0177.0.0.1/` (octal localhost) slips past a literal-IP check.
 * Returns the four octets of the resulting 32-bit address, or null when the
 * string is not a numeric IPv4 in any of these encodings.
 */
function parseIpv4Loose(address: string): number[] | null {
	const parts = address.split(".");
	if (parts.length < 1 || parts.length > 4) {
		return null;
	}
	const values: number[] = [];
	for (const part of parts) {
		let value: number;
		if (/^0x[0-9a-f]+$/i.test(part)) {
			value = Number.parseInt(part.slice(2), 16);
		} else if (/^0[0-7]+$/.test(part)) {
			value = Number.parseInt(part, 8);
		} else if (/^(?:0|[1-9][0-9]*)$/.test(part)) {
			value = Number.parseInt(part, 10);
		} else {
			return null;
		}
		if (!Number.isSafeInteger(value) || value < 0) {
			return null;
		}
		values.push(value);
	}
	const n = values.length;
	// Each leading part is a single byte; the final part absorbs the rest.
	for (let i = 0; i < n - 1; i++) {
		if (values[i] > 0xff) return null;
	}
	const lastMax = [0xffffffff, 0xffffff, 0xffff, 0xff][n - 1];
	if (values[n - 1] > lastMax) {
		return null;
	}
	let ip = 0;
	for (let i = 0; i < n - 1; i++) {
		ip += values[i] * 2 ** (8 * (3 - i));
	}
	ip += values[n - 1];
	if (ip > 0xffffffff) {
		return null;
	}
	return [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff];
}

function parseIpv4FromMappedIpv6(mapped: string): number[] | null {
	if (mapped.includes(".")) {
		return parseIpv4(mapped);
	}
	const parts = mapped.split(":").filter(Boolean);
	if (parts.length === 1) {
		const value = Number.parseInt(parts[0], 16);
		if (Number.isNaN(value) || value < 0 || value > 0xffff_ffff) {
			return null;
		}
		return [
			(value >>> 24) & 0xff,
			(value >>> 16) & 0xff,
			(value >>> 8) & 0xff,
			value & 0xff,
		];
	}
	if (parts.length !== 2) {
		return null;
	}
	const high = Number.parseInt(parts[0], 16);
	const low = Number.parseInt(parts[1], 16);
	if (
		Number.isNaN(high) ||
		Number.isNaN(low) ||
		high < 0 ||
		low < 0 ||
		high > 0xffff ||
		low > 0xffff
	) {
		return null;
	}
	const value = (high << 16) + low;
	return [
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	];
}

function isPrivateIpv4(parts: number[]): boolean {
	const [octet1, octet2, octet3] = parts;
	if (octet1 === 0) {
		return true;
	}
	if (octet1 === 10) {
		return true;
	}
	if (octet1 === 127) {
		return true;
	}
	if (octet1 === 169 && octet2 === 254) {
		return true;
	}
	if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) {
		return true;
	}
	if (octet1 === 192 && octet2 === 168) {
		return true;
	}
	if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) {
		return true;
	}
	// Special-purpose ranges kept in parity with the cloud outbound guard:
	// not globally routable, but internally reachable on carrier/lab networks.
	if (octet1 === 192 && octet2 === 0 && octet3 === 0) {
		return true;
	}
	if (octet1 === 198 && (octet2 === 18 || octet2 === 19)) {
		return true;
	}
	if (octet1 >= 224) {
		return true;
	}
	return false;
}

/**
 * Expand an IPv6 address string into its eight 16-bit groups, handling `::`
 * compression and a dotted-quad tail (`64:ff9b::169.254.169.254`, the
 * inet_pton mixed form). Returns null when the string is not a syntactically
 * valid IPv6 address — the caller then falls back to the first-hextet
 * classification only.
 */
function parseIpv6Hextets(address: string): number[] | null {
	let input = address;
	// A dotted tail carries the final 32 bits as IPv4 text; rewrite it in place
	// as two hex groups so the expansion below stays uniform. Keeping the colon
	// that precedes the tail preserves a `::` compression spanning it.
	if (input.includes(".")) {
		const colon = input.lastIndexOf(":");
		if (colon === -1) return null;
		const ipv4 = parseIpv4(input.slice(colon + 1));
		if (!ipv4) return null;
		input = `${input.slice(0, colon + 1)}${(((ipv4[0] << 8) | ipv4[1]) & 0xffff).toString(16)}:${(((ipv4[2] << 8) | ipv4[3]) & 0xffff).toString(16)}`;
	}
	const parseGroups = (text: string): number[] | null => {
		if (!text) return [];
		const groups: number[] = [];
		for (const part of text.split(":")) {
			if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
			groups.push(Number.parseInt(part, 16));
		}
		return groups;
	};
	const halves = input.split("::");
	if (halves.length > 2) return null;
	const head = parseGroups(halves[0] ?? "");
	if (head === null) return null;
	if (halves.length === 1) {
		return head.length === 8 ? head : null;
	}
	const tail = parseGroups(halves[1] ?? "");
	if (tail === null) return null;
	// "::" must compress at least one all-zero group.
	const zeros = 8 - (head.length + tail.length);
	if (zeros < 1) return null;
	return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

/**
 * Extract the policy-relevant embedded IPv4 from the transition/coexistence
 * ranges an attacker can route to internal space: IPv4-compatible `::/96`
 * (deprecated, still honored by some stacks), NAT64 `64:ff9b::/96` (RFC 6052
 * well-known prefix — live on AWS IPv6-only/DNS64 subnets), 6to4 `2002::/16`
 * (RFC 3056, IPv4 in bits 16..48), and Teredo `2001:0000::/32` (RFC 4380,
 * client IPv4 XOR-obfuscated in the low 32 bits). On those network paths a
 * literal URL never touches DNS, so screening the embedded IPv4 is the only
 * chance to classify the address the packet actually reaches. Returns null
 * when the address is outside those ranges.
 */
function embeddedIpv4ForPolicy(hextets: number[]): number[] | null {
	const [h0, h1, h2, , , h5, h6, h7] = hextets;
	const low32ToIpv4 = (): number[] => [
		(h6 >> 8) & 0xff,
		h6 & 0xff,
		(h7 >> 8) & 0xff,
		h7 & 0xff,
	];
	// IPv4-compatible ::/96 and IPv4-mapped ::ffff:0:0/96 spellings that
	// survived normalizeIpForPolicy — the embedded address is the low 32 bits.
	// (`::` and `::1` are classified by the caller before this runs.)
	if (h0 === 0 && h1 === 0 && h2 === 0 && hextets[3] === 0) {
		if (hextets[4] === 0 && (h5 === 0 || h5 === 0xffff)) {
			return low32ToIpv4();
		}
	}
	// NAT64 well-known prefix 64:ff9b::/96 — embedded IPv4 is the low 32 bits.
	if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && hextets[3] === 0) {
		if (hextets[4] === 0 && h5 === 0) {
			return low32ToIpv4();
		}
	}
	// 6to4 2002::/16 — embedded IPv4 sits in bits 16..48.
	if (h0 === 0x2002) {
		return [(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff];
	}
	// Teredo 2001:0000::/32 — client IPv4 is the low 32 bits XOR 0xffffffff.
	if (h0 === 0x2001 && h1 === 0x0000) {
		return [
			((h6 ^ 0xffff) >> 8) & 0xff,
			(h6 ^ 0xffff) & 0xff,
			((h7 ^ 0xffff) >> 8) & 0xff,
			(h7 ^ 0xffff) & 0xff,
		];
	}
	return null;
}

function isPrivateIpv6(address: string): boolean {
	if (address === "::" || address === "::1") return true;
	const firstHextet = /^([0-9a-f]{1,4})(?=:|$)/i.exec(address)?.[1];
	if (firstHextet) {
		const first = Number.parseInt(firstHextet, 16);
		if (
			(first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
			(first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
			(first & 0xffc0) === 0xfec0 || // fec0::/10 deprecated site-local
			(first & 0xff00) === 0xff00 // ff00::/8 multicast
		) {
			return true;
		}
	}
	// Transition ranges embed an IPv4 the network may translate the literal to
	// (e.g. http://[64:ff9b::a9fe:a9fe]/ reaching 169.254.169.254 through
	// NAT64), so screen that embedded address with the IPv4 policy too. This
	// also covers leading-"::" spellings the first-hextet scan above can't see.
	const hextets = parseIpv6Hextets(address);
	if (hextets) {
		const embedded = embeddedIpv4ForPolicy(hextets);
		if (embedded && isPrivateIpv4(embedded)) {
			return true;
		}
	}
	return false;
}

/**
 * Check if an IP address is private/internal.
 */
export function isPrivateIpAddress(address: string): boolean {
	const normalized = normalizeIpForPolicy(address);
	if (!normalized) {
		return false;
	}

	if (normalized.includes(":")) {
		return isPrivateIpv6(normalized);
	}

	const strict = parseIpv4(normalized);
	if (strict && isPrivateIpv4(strict)) {
		return true;
	}
	// Also classify the inet_aton interpretation the OS resolver would actually
	// connect to, so octal/hex/decimal/short-form encodings of a private IP
	// (e.g. "0177.0.0.1", "0x7f.0.0.1", "2130706433", "127.1") cannot bypass a
	// literal-IP SSRF check by reading as a public address here.
	const loose = parseIpv4Loose(normalized);
	if (loose && isPrivateIpv4(loose)) {
		return true;
	}
	return false;
}

/**
 * Check if a hostname should be blocked (localhost, internal domains).
 */
export function isBlockedHostname(hostname: string): boolean {
	const normalized = normalizeHostLike(hostname);
	if (!normalized) {
		return false;
	}
	if (BLOCKED_HOSTNAMES.has(normalized)) {
		return true;
	}
	return (
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal")
	);
}

/**
 * Create a DNS lookup function that pins to specific resolved addresses.
 */
export function createPinnedLookup(params: {
	hostname: string;
	addresses: string[];
	fallback?: PinnedLookup;
}): PinnedLookup {
	const normalizedHost = normalizeHostLike(params.hostname);
	const fallback = params.fallback;
	// Drop any non-string/empty address before pinning. An undefined address
	// reaching node's net layer throws "Invalid IP address: undefined" and the
	// pinned fetch fails hard; filtering keeps the valid records usable.
	const records = params.addresses
		.filter(
			(address): address is string =>
				typeof address === "string" && address.length > 0,
		)
		.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));
	let index = 0;

	const lookup: PinnedLookup = (
		host: string,
		options?: LookupOptions | LookupCallback,
		callback?: LookupCallback,
	) => {
		const cb = typeof options === "function" ? options : callback;
		if (!cb) {
			return;
		}
		const normalized = normalizeHostLike(host);
		if (!normalized || normalized !== normalizedHost) {
			if (fallback) {
				if (typeof options === "function" || options === undefined) {
					return fallback(host, cb);
				}
				return fallback(host, options, cb);
			}
			throw new Error("DNS Context restricted: fallback missing.");
		}

		const opts = typeof options === "object" && options !== null ? options : {};
		const requestedFamily =
			typeof options === "number"
				? options
				: typeof opts.family === "number"
					? opts.family
					: 0;
		const candidates =
			requestedFamily === 4 || requestedFamily === 6
				? records.filter((entry) => entry.family === requestedFamily)
				: records;
		const usable = candidates.length > 0 ? candidates : records;
		if (opts.all) {
			cb(null, usable);
			return;
		}
		const chosen = usable[index % usable.length];
		index += 1;
		cb(null, chosen.address, chosen.family);
	};

	return lookup;
}

export type PinnedHostname = {
	hostname: string;
	addresses: string[];
	lookup: PinnedLookup;
};

/**
 * Resolve a hostname with SSRF policy enforcement.
 */
export async function resolvePinnedHostnameWithPolicy(
	hostname: string,
	params: { lookupFn?: LookupFn; policy?: SsrfPolicy } = {},
): Promise<PinnedHostname> {
	const normalized = normalizeHostLike(hostname);
	if (!normalized) {
		throw new Error("Invalid hostname");
	}

	const allowPrivateNetwork = Boolean(params.policy?.allowPrivateNetwork);
	const allowedHostnames = normalizeHostnameSet(
		params.policy?.allowedHostnames,
	);
	const isExplicitAllowed = allowedHostnames.has(normalized);

	if (!allowPrivateNetwork && !isExplicitAllowed) {
		if (isBlockedHostname(normalized)) {
			throw new SsrfBlockedError(`Blocked hostname: ${hostname}`);
		}

		if (isPrivateIpAddress(normalized)) {
			throw new SsrfBlockedError("Blocked: private/internal IP address");
		}
	}

	const lookupFn = params.lookupFn;
	if (!lookupFn)
		throw new Error("lookupFn is required in environment agnostic core");
	const results = await lookupFn(normalized, { all: true });
	// Drop holes (undefined/empty) a resolver may emit before any address is
	// inspected: an undefined address must never reach the private-IP check
	// (it would throw on `.trim()`) nor the pinned lookup (it would pin the
	// string "undefined"). This also covers an empty result set — both fail
	// closed with "Unable to resolve hostname".
	const addresses = Array.from(
		new Set(
			results
				.map((entry) => entry.address)
				.filter(
					(address): address is string =>
						typeof address === "string" && address.length > 0,
				),
		),
	);
	if (addresses.length === 0) {
		throw new Error(`Unable to resolve hostname: ${hostname}`);
	}

	if (!allowPrivateNetwork && !isExplicitAllowed) {
		for (const address of addresses) {
			if (isPrivateIpAddress(address)) {
				throw new SsrfBlockedError(
					"Blocked: resolves to private/internal IP address",
				);
			}
		}
	}

	return {
		hostname: normalized,
		addresses,
		lookup: createPinnedLookup({ hostname: normalized, addresses }),
	};
}

/**
 * Resolve a hostname and pin DNS to prevent TOCTOU attacks.
 */
export async function resolvePinnedHostname(
	hostname: string,
	lookupFn?: LookupFn,
): Promise<PinnedHostname> {
	return resolvePinnedHostnameWithPolicy(hostname, { lookupFn });
}

/**
 * Assert that a hostname resolves to a public IP address.
 */
export async function assertPublicHostname(
	hostname: string,
	lookupFn?: LookupFn,
): Promise<void> {
	await resolvePinnedHostname(hostname, lookupFn);
}
