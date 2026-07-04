/**
 * Session-scoped secret-swap layer that sits between the agent and the model:
 * on ingress it detects secrets/PII in text and structured params and replaces
 * each with a per-session nonce'd placeholder (`__ELIZA_SECRET_<nonce>_<n>__`)
 * so the raw value never reaches the model; on egress it restores the originals
 * at the execution boundary (tool call / outbound request).
 *
 * Ingress draws assignment-style secrets from the shared redact pattern set
 * (`./redact`) and validated PII/token classes from `./pii-detectors`; a generic
 * length floor gates the former while proven-sensitive PII swaps at a lower floor.
 *
 * The per-session nonce makes placeholders unforgeable: restore and assertion
 * scope only to THIS session's nonce, so a placeholder-shaped token from user
 * input or model output can never resolve to a real secret. A this-session
 * placeholder that should resolve but does not (e.g. a model that fabricated
 * `…_999__`) can fail loud via SecretSwapUnresolvedPlaceholderError rather than
 * silently leak.
 */
import { detectPii } from "./pii-detectors";
import { getDefaultRedactPatterns } from "./redact";

export const SECRET_SWAP_ENABLED_SETTING = "ELIZA_SECRET_SWAP_ENABLED";
export const SECRET_SWAP_EXEMPT_VALUES_SETTING =
	"ELIZA_SECRET_SWAP_EXEMPT_VALUES";

export class SecretSwapUnresolvedPlaceholderError extends Error {
	readonly placeholders: string[];

	constructor(placeholders: string[]) {
		super(`Unresolved secret placeholder(s): ${placeholders.join(", ")}`);
		this.name = "SecretSwapUnresolvedPlaceholderError";
		this.placeholders = placeholders;
	}
}

export type SecretSwapEntry = {
	placeholder: string;
	value: string;
	kind: string;
};

export type SecretSwapSessionOptions = {
	knownSecrets?: Record<string, string | undefined>;
	exemptValues?: Iterable<string>;
	/**
	 * PII/token detector classes to disable (false-positive opt-out by class,
	 * e.g. `["phone", "ipv4"]`). Complements `exemptValues` (opt-out by value).
	 */
	disabledKinds?: Iterable<string>;
};

const MIN_SWAP_VALUE_LENGTH = 8;
/** Validated PII spans (email, card, SSN, …) swap even when short — the detector
 * already proved they are sensitive, so the generic length floor does not apply. */
const MIN_PII_VALUE_LENGTH = 4;
const PLACEHOLDER_PREFIX = "__ELIZA_SECRET_";
/**
 * Broad "looks like one of our placeholders" pattern (any session nonce, or the
 * legacy no-nonce form). Used only to AVOID swapping a value that is already a
 * placeholder; actual restore is scoped to the session-specific nonce so a
 * forged placeholder from input/model output never resolves to a real secret.
 */
const PLACEHOLDER_PATTERN = /__ELIZA_SECRET_(?:[0-9a-f]{8,}_)?\d+__/g;

/**
 * A per-session random nonce woven into every placeholder
 * (`__ELIZA_SECRET_<nonce>_<n>__`). Without it, a user message or model output
 * could contain a literal `__ELIZA_SECRET_1__` that collides with a real
 * mapping, hijacking restore to leak the secret into an unintended position —
 * the nonce makes placeholders unforgeable and unguessable per turn.
 */
function generateSessionNonce(): string {
	const bytes = new Uint8Array(8);
	const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
	if (typeof cryptoObj?.getRandomValues === "function") {
		cryptoObj.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parsePattern(raw: string): RegExp | null {
	if (!raw.trim()) return null;
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	try {
		if (match) {
			const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
			return new RegExp(match[1], flags);
		}
		return new RegExp(raw, "gi");
	} catch {
		return null;
	}
}

const SECRET_PATTERNS: readonly RegExp[] = getDefaultRedactPatterns()
	.map(parsePattern)
	.filter((pattern): pattern is RegExp => Boolean(pattern));

function shouldSwapValue(
	value: string,
	exemptValues: ReadonlySet<string>,
): boolean {
	const trimmed = value.trim();
	return (
		trimmed.length >= MIN_SWAP_VALUE_LENGTH &&
		!exemptValues.has(trimmed) &&
		!trimmed.match(PLACEHOLDER_PATTERN)
	);
}

function extractToken(match: string, groups: readonly unknown[]): string {
	const stringGroups = groups.filter(
		(group): group is string => typeof group === "string" && group.length > 0,
	);
	return stringGroups[stringGroups.length - 1] ?? match;
}

function collectMatches(
	text: string,
	patterns: readonly RegExp[],
	exemptValues: ReadonlySet<string>,
): string[] {
	const values: string[] = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const token = extractToken(match[0], match.slice(1));
			if (shouldSwapValue(token, exemptValues)) {
				values.push(token);
			}
		}
	}
	return values;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

export class SecretSwapSession {
	private readonly valueToEntry = new Map<string, SecretSwapEntry>();
	private readonly placeholderToEntry = new Map<string, SecretSwapEntry>();
	private readonly exemptValues: ReadonlySet<string>;
	private readonly disabledKinds: ReadonlySet<string>;
	/** Per-session nonce woven into every placeholder so it is unforgeable. */
	private readonly nonce = generateSessionNonce();
	/**
	 * Restore/assert match only THIS session's nonce'd placeholders. A
	 * placeholder-shaped string with a different/legacy nonce is benign text the
	 * layer never minted — it cannot reference a real secret, so it is left as-is
	 * (no leak) rather than triggering a false "unresolved" failure. Fail-loud is
	 * reserved for a this-session placeholder that should resolve but does not
	 * (e.g. a model that fabricated `…_999__`).
	 */
	private readonly placeholderPattern = new RegExp(
		`__ELIZA_SECRET_${this.nonce}_\\d+__`,
		"g",
	);

	constructor(options: SecretSwapSessionOptions = {}) {
		this.exemptValues = new Set(
			[...(options.exemptValues ?? [])]
				.map((value) => value.trim())
				.filter(Boolean),
		);
		this.disabledKinds = new Set(
			[...(options.disabledKinds ?? [])]
				.map((value) => value.trim())
				.filter(Boolean),
		);
		for (const [name, value] of Object.entries(options.knownSecrets ?? {})) {
			if (
				typeof value === "string" &&
				shouldSwapValue(value, this.exemptValues)
			) {
				this.entryForValue(value, name);
			}
		}
	}

	get entries(): SecretSwapEntry[] {
		return [...this.valueToEntry.values()];
	}

	substituteText(text: string): string {
		let result = text;
		// 1) Assignment-style secrets (KEY=…, "token":"…", Bearer …, PEM blocks)
		//    from the shared redact pattern set — value-extracted, length-gated.
		for (const value of collectMatches(
			result,
			SECRET_PATTERNS,
			this.exemptValues,
		)) {
			this.entryForValue(value, "secret");
		}
		// 2) Validated PII / token classes (credit-card+Luhn, email, ssn, iban,
		//    jwt, cloud keys, …). Already proven sensitive by their detector, so
		//    a lower length floor applies; class can be opted out via disabledKinds.
		for (const match of detectPii(result, {
			disabledKinds: this.disabledKinds,
		})) {
			const trimmed = match.value.trim();
			if (
				trimmed.length >= MIN_PII_VALUE_LENGTH &&
				!this.exemptValues.has(trimmed) &&
				!trimmed.match(PLACEHOLDER_PATTERN)
			) {
				this.entryForValue(trimmed, match.kind);
			}
		}
		// Replace longest-first so a value that is a substring of another does not
		// corrupt the longer placeholder.
		for (const entry of this.entries.sort(
			(a, b) => b.value.length - a.value.length,
		)) {
			result = result.split(entry.value).join(entry.placeholder);
		}
		return result;
	}

	substituteInValue<T>(value: T): T {
		if (typeof value === "string") {
			return this.substituteText(value) as T;
		}
		if (Array.isArray(value)) {
			return value.map((item) => this.substituteInValue(item)) as T;
		}
		if (isPlainObject(value)) {
			const next: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(value)) {
				next[key] = this.substituteInValue(child);
			}
			return next as T;
		}
		return value;
	}

	restoreText(
		text: string,
		options: { failOnUnresolved?: boolean } = {},
	): string {
		const unresolved = new Set<string>();
		this.placeholderPattern.lastIndex = 0;
		const restored = text.replace(this.placeholderPattern, (placeholder) => {
			const entry = this.placeholderToEntry.get(placeholder);
			if (!entry) {
				unresolved.add(placeholder);
				return placeholder;
			}
			return entry.value;
		});
		if (options.failOnUnresolved && unresolved.size > 0) {
			throw new SecretSwapUnresolvedPlaceholderError([...unresolved].sort());
		}
		return restored;
	}

	restoreInValue<T>(value: T, options: { failOnUnresolved?: boolean } = {}): T {
		if (typeof value === "string") {
			return this.restoreText(value, options) as T;
		}
		if (Array.isArray(value)) {
			return value.map((item) => this.restoreInValue(item, options)) as T;
		}
		if (isPlainObject(value)) {
			const next: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(value)) {
				next[key] = this.restoreInValue(child, options);
			}
			return next as T;
		}
		return value;
	}

	assertNoUnresolvedPlaceholders(value: unknown): void {
		const serialized =
			typeof value === "string"
				? value
				: (() => {
						try {
							return JSON.stringify(value);
						} catch {
							return String(value);
						}
					})();
		this.placeholderPattern.lastIndex = 0;
		const placeholders = [
			...new Set(serialized.match(this.placeholderPattern) ?? []),
		]
			.filter((placeholder) => !this.placeholderToEntry.has(placeholder))
			.sort();
		if (placeholders.length > 0) {
			throw new SecretSwapUnresolvedPlaceholderError(placeholders);
		}
	}

	private entryForValue(value: string, kind: string): SecretSwapEntry {
		const existing = this.valueToEntry.get(value);
		if (existing) return existing;
		const entry = {
			placeholder: `${PLACEHOLDER_PREFIX}${this.nonce}_${this.valueToEntry.size + 1}__`,
			value,
			kind,
		};
		this.valueToEntry.set(value, entry);
		this.placeholderToEntry.set(entry.placeholder, entry);
		return entry;
	}
}

export function parseSecretSwapExemptValues(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}
