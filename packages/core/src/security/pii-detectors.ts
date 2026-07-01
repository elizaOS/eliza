/**
 * PII / sensitive-token detectors for the secret-swap layer (#10469).
 *
 * The secret-swap layer needs to find "easy-to-match" PII and well-known secret
 * token shapes in free text so it can substitute deterministic placeholders
 * before the model ever sees the raw value. This module is the detection half:
 * a registry of named detectors, each a global `RegExp` plus an optional
 * structural `validate()` that rejects false positives (e.g. a 16-digit number
 * that fails the Luhn checksum is not a credit card; `999-…` is not a valid SSN;
 * `300.1.2.3` is not an IPv4 address).
 *
 * Design constraints:
 * - **Low false positives.** Every numeric/structured class is checksum- or
 *   range-validated (Luhn for cards, mod-97 for IBAN, octet range for IPv4,
 *   SSA allocation rules for SSN). A detector that would over-match is gated by
 *   its validator, not loosened.
 * - **Pure + side-effect-free.** Detectors never mutate; `detectPii()` returns
 *   the matched spans so the caller (the swap session) owns substitution.
 * - **Overlap resolution.** When two detectors match overlapping spans, the
 *   longer (more specific) span wins, so a credit card inside a longer digit run
 *   is not also half-matched as a phone number.
 *
 * The exported helpers (`luhnValid`, `ibanValid`, `ssnValid`, `ipv4Valid`,
 * `wifValid`) are the validation primitives, exposed so the fuzz / red-team /
 * unit suites can exercise them directly.
 */

import { createHash } from "../utils/crypto-compat";
import { findAllMnemonicPhrases } from "./bip39-wordlist";

/** A single PII / token class detector. */
export interface PiiDetector {
	/** Stable, lower-kebab class name surfaced on the swap entry (e.g. "credit-card"). */
	readonly kind: string;
	/** Global regex. Must carry the `g` flag (enforced at registry build time). */
	readonly pattern: RegExp;
	/**
	 * Structural acceptance check. Receives the full match and its capture groups;
	 * return `false` to reject the candidate (e.g. failed checksum). When omitted,
	 * any regex match is accepted.
	 */
	readonly validate?: (
		match: string,
		groups: readonly (string | undefined)[],
	) => boolean;
	/**
	 * Extract the sensitive token from the match (default: the last non-empty
	 * capture group, else the whole match). Lets a detector match surrounding
	 * context (`password=...`) but swap only the value.
	 */
	readonly extract?: (match: RegExpMatchArray) => string;
	/**
	 * Custom span finder that fully replaces the regex loop for this detector.
	 * Used when a single regex match can contain several independent secrets
	 * (e.g. two adjacent BIP-39 mnemonics in one word run), so every one is
	 * emitted rather than just the first. When present, `pattern`/`validate`/
	 * `extract` are ignored for this detector.
	 */
	readonly findSpans?: (
		text: string,
	) => ReadonlyArray<{ value: string; start: number; end: number }>;
}

/** A detected span: the sensitive value, its class, and its position in the text. */
export interface PiiMatch {
	readonly kind: string;
	readonly value: string;
	readonly start: number;
	readonly end: number;
}

// ---------------------------------------------------------------------------
// Validation primitives (exported for direct testing)
// ---------------------------------------------------------------------------

/** Luhn (mod-10) checksum over a pure-digit string. */
export function luhnValid(digits: string): boolean {
	if (digits.length === 0 || /\D/.test(digits)) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let d = digits.charCodeAt(i) - 48;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/** Major card brand for a pure-digit PAN, or `null` if it matches none. */
export function cardBrand(digits: string): string | null {
	if (/^4\d{12}(?:\d{3})?(?:\d{3})?$/.test(digits)) return "visa";
	if (
		/^(?:5[1-5]\d{14}|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)\d{12})$/.test(
			digits,
		)
	)
		return "mastercard";
	if (/^3[47]\d{13}$/.test(digits)) return "amex";
	if (/^(?:6011\d{12}|65\d{14}|64[4-9]\d{13}|622\d{13})$/.test(digits))
		return "discover";
	if (/^3(?:0[0-5]\d{11}|[68]\d{12})$/.test(digits)) return "diners";
	if (/^35(?:2[89]|[3-8]\d)\d{12}$/.test(digits)) return "jcb";
	return null;
}

/** A credit-card candidate is valid when Luhn passes AND it matches a known brand. */
function creditCardValid(match: string): boolean {
	const digits = match.replace(/[\s-]/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	return luhnValid(digits) && cardBrand(digits) !== null;
}

/** US SSA allocation rules: reject the ranges the SSA never issues. */
export function ssnValid(value: string): boolean {
	const d = value.replace(/\D/g, "");
	if (d.length !== 9) return false;
	const area = d.slice(0, 3);
	const group = d.slice(3, 5);
	const serial = d.slice(5);
	if (area === "000" || area === "666" || Number(area) >= 900) return false;
	if (group === "00") return false;
	if (serial === "0000") return false;
	return true;
}

/** Every dotted-quad octet is 0–255 (rejects `300.1.2.3`, version strings, etc.). */
export function ipv4Valid(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** ISO 13616 IBAN mod-97 check (rearrange, letters→digits, remainder === 1). */
export function ibanValid(value: string): boolean {
	const s = value.replace(/\s/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
	const rearranged = s.slice(4) + s.slice(0, 4);
	let remainder = 0;
	for (const ch of rearranged) {
		const code = ch.charCodeAt(0);
		// A–Z → 10–35, 0–9 → itself.
		const chunk = code >= 65 ? String(code - 55) : String.fromCharCode(code);
		for (const c of chunk)
			remainder = (remainder * 10 + (c.charCodeAt(0) - 48)) % 97;
	}
	return remainder === 1;
}

const BASE58_ALPHABET =
	"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
	[...BASE58_ALPHABET].map((c, i) => [c, BigInt(i)]),
);

/** Base58 decode → bytes, or null on an invalid character. */
function base58Decode(input: string): Uint8Array | null {
	let num = 0n;
	for (const ch of input) {
		const v = BASE58_INDEX.get(ch);
		if (v === undefined) return null;
		num = num * 58n + v;
	}
	const bytes: number[] = [];
	while (num > 0n) {
		bytes.unshift(Number(num & 0xffn));
		num >>= 8n;
	}
	for (const ch of input) {
		if (ch === "1") bytes.unshift(0);
		else break;
	}
	return Uint8Array.from(bytes);
}

/**
 * Bitcoin WIF private key: base58check with version byte 0x80 (mainnet) / 0xEF
 * (testnet), a 32-byte payload (optionally + 0x01 compression flag), and a
 * trailing 4-byte double-SHA256 checksum. The checksum makes the base58 shape
 * unambiguous (an IPFS CID or other base58 blob is rejected).
 */
export function wifValid(value: string): boolean {
	const decoded = base58Decode(value);
	if (!decoded || (decoded.length !== 37 && decoded.length !== 38))
		return false;
	const version = decoded[0];
	if (version !== 0x80 && version !== 0xef) return false;
	if (decoded.length === 38 && decoded[decoded.length - 5] !== 0x01)
		return false;
	const body = decoded.subarray(0, decoded.length - 4);
	const checksum = decoded.subarray(decoded.length - 4);
	const h1 = createHash("sha256").update(body).digest() as Uint8Array;
	const h2 = createHash("sha256").update(h1).digest() as Uint8Array;
	for (let i = 0; i < 4; i += 1) {
		if (h2[i] !== checksum[i]) return false;
	}
	return true;
}

/** Base64 string decodes to a `user:password` pair (basic-auth credentials). */
function basicAuthValid(b64: string): boolean {
	try {
		const decoded =
			typeof atob === "function"
				? atob(b64)
				: Buffer.from(b64, "base64").toString("latin1");
		return decoded.includes(":") && decoded.length >= 3;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Detector registry
// ---------------------------------------------------------------------------

/**
 * Ordered detector registry. Order matters only for tie-breaking when two
 * detectors produce the exact same span; otherwise `detectPii` resolves by
 * span length. Higher-specificity classes are listed first.
 */
export const PII_DETECTORS: readonly PiiDetector[] = [
	// RFC-5322-ish email (case-insensitive).
	{
		kind: "email",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
	},
	// Credit card / PAN. Matched as a contiguous 13–19 digit BLOCK, or as
	// card-style fixed groups (4-4-4-N, or Amex 4-6-5) separated by a single space
	// or dash. The per-digit separator form is deliberately avoided: it lets a
	// stray leading digit ("42 4768…") be greedily consumed into an invalid
	// superset that fails Luhn and masks the real card. Luhn + brand gated.
	{
		kind: "credit-card",
		pattern:
			/\b\d{13,19}\b|\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b|\b\d{4}[ -]\d{6}[ -]\d{5}\b/g,
		validate: (match) => creditCardValid(match),
	},
	// US SSN, dashed or spaced; allocation-rule validated.
	{
		kind: "ssn",
		pattern: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g,
		validate: (match) => ssnValid(match),
	},
	// IBAN — country + 2 check digits + BBAN; mod-97 validated.
	{
		kind: "iban",
		pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
		validate: (match) => ibanValid(match),
	},
	// JWT — three base64url segments; the first two start with the canonical
	// `eyJ` (`{"`) so this does not match arbitrary dotted base64.
	{
		kind: "jwt",
		pattern:
			/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
	},
	// BIP-39 mnemonic seed phrase — wordlist + checksum validated (near-zero FP;
	// an ordinary 12-word English sentence is rejected by the checksum). Uses a
	// custom span finder so every phrase in a word run is emitted (a single regex
	// match over two adjacent mnemonics would otherwise leave the second unswapped).
	{
		kind: "seed-phrase",
		pattern: /\b(?:[a-zA-Z]{3,8}[ \t]+){11,}[a-zA-Z]{3,8}\b/g,
		findSpans: (text) => findAllMnemonicPhrases(text),
	},
	// Bitcoin WIF private key — base58check (version + 4-byte double-SHA256)
	// validated, so an IPFS CID / other base58 blob is rejected.
	{
		kind: "wif-private-key",
		pattern: /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,
		validate: (match) => wifValid(match),
	},
	// URL / DB connection string with embedded user:password — swap the whole
	// credential. Covers the issue-named "DB creds with passwords" + account
	// passwords inside URLs, which no assignment/token pattern catches today.
	{
		kind: "url-credentials",
		pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@[^\s"'<>]+/gi,
		extract: (match) => match[0],
	},
	// Anthropic API key — registered BEFORE openai-key so its more specific
	// prefix wins the same-span tie (otherwise mislabelled "openai-key").
	{
		kind: "anthropic-key",
		pattern: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{16,}\b/g,
	},
	// Stripe webhook signing secret.
	{ kind: "stripe-webhook-secret", pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
	// Slack incoming-webhook URL — the trailing segment is the capability secret.
	{
		kind: "slack-webhook-url",
		pattern:
			/https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/g,
	},
	// HTTP Basic auth header — base64(user:pass). redact.ts covers Bearer, not
	// Basic, so base64-wrapped credentials are sent in the clear today.
	{
		kind: "basic-auth-header",
		pattern: /\bAuthorization\s*:\s*Basic\s+([A-Za-z0-9+/]{12,}={0,2})/gi,
		validate: (_match, groups) =>
			typeof groups[0] === "string" && basicAuthValid(groups[0]),
	},
	// Google OAuth refresh token (1// prefix; left-guarded against URL paths).
	{
		kind: "google-oauth-refresh-token",
		pattern: /(?<![\w/])1\/\/[0-9A-Za-z_-]{20,}\b/g,
	},
	// Telegram bot token (digits:AA…); tighter + labelled vs the loose redact form.
	{
		kind: "telegram-bot-token",
		pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g,
	},
	// PGP private key block (the PEM end-marker doesn't cover "KEY BLOCK").
	{
		kind: "pgp-private-key",
		pattern:
			/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]+?-----END PGP PRIVATE KEY BLOCK-----/g,
	},
	// AWS access key id.
	{
		kind: "aws-access-key",
		pattern: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g,
	},
	// Stripe-style secret/restricted/publishable keys.
	{
		kind: "stripe-key",
		pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
	},
	// Google API key.
	{ kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	// GitHub tokens.
	{
		kind: "github-token",
		pattern:
			/\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{22,}\b/g,
	},
	// OpenAI-style key.
	{ kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
	// Slack tokens.
	{ kind: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
	// Private key PEM block.
	{
		kind: "private-key",
		pattern:
			/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
	},
	// EVM/0x hex private key or address-shaped 32-byte hex (kept conservative: 64 hex).
	{ kind: "hex-secret", pattern: /\b0x[a-fA-F0-9]{64}\b/g },
	// MAC address.
	{
		kind: "mac-address",
		pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
	},
	// IPv4 (octet-range validated).
	{
		kind: "ipv4",
		pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
		validate: (match) => ipv4Valid(match),
	},
	// E.164 / North-American phone numbers. The NANP branch requires a separator
	// (space/dot/dash) or parenthesised area code so a bare 10-digit run (an id,
	// timestamp, etc.) is NOT mistaken for a phone number; the intl branch needs
	// the leading `+`.
	{
		kind: "phone",
		pattern:
			/(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?!\d)|\+[1-9]\d{7,14}(?!\d)/g,
	},
];

/** Detectors keyed by `kind` (for opt-out / configuration). */
export const PII_DETECTOR_BY_KIND: ReadonlyMap<string, PiiDetector> = new Map(
	PII_DETECTORS.map((d) => [d.kind, d]),
);

function extractValue(detector: PiiDetector, match: RegExpMatchArray): string {
	if (detector.extract) return detector.extract(match);
	const groups = match.slice(1).filter((g): g is string => Boolean(g));
	return groups.length > 0 ? (groups[groups.length - 1] as string) : match[0];
}

/**
 * Detect all PII / token spans in `text`. Returns one {@link PiiMatch} per
 * accepted, non-overlapping span (longest span wins on overlap), in order of
 * appearance. `disabledKinds` skips specific classes (false-positive opt-out).
 */
export function detectPii(
	text: string,
	options: { disabledKinds?: ReadonlySet<string> } = {},
): PiiMatch[] {
	const disabled = options.disabledKinds;
	const candidates: PiiMatch[] = [];
	for (const detector of PII_DETECTORS) {
		if (disabled?.has(detector.kind)) continue;
		if (detector.findSpans) {
			for (const span of detector.findSpans(text)) {
				if (span.value) {
					candidates.push({
						kind: detector.kind,
						value: span.value,
						start: span.start,
						end: span.end,
					});
				}
			}
			continue;
		}
		detector.pattern.lastIndex = 0;
		for (const match of text.matchAll(detector.pattern)) {
			const whole = match[0];
			if (detector.validate && !detector.validate(whole, match.slice(1))) {
				continue;
			}
			const value = extractValue(detector, match);
			if (!value) continue;
			const start = (match.index ?? 0) + whole.indexOf(value);
			candidates.push({
				kind: detector.kind,
				value,
				start,
				end: start + value.length,
			});
		}
	}
	// Resolve overlaps: sort by length desc, then position; greedily keep
	// non-overlapping spans so the most specific (longest) match wins.
	candidates.sort(
		(a, b) => b.value.length - a.value.length || a.start - b.start,
	);
	const kept: PiiMatch[] = [];
	for (const cand of candidates) {
		const overlaps = kept.some((k) => cand.start < k.end && k.start < cand.end);
		if (!overlaps) kept.push(cand);
	}
	kept.sort((a, b) => a.start - b.start);
	return kept;
}
