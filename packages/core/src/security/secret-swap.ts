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
import { ElizaError } from "../errors";
import { BufferUtils } from "../utils/buffer";
import { detectPii } from "./pii-detectors";
import { getDefaultRedactPatterns } from "./redact";

export const SECRET_SWAP_ENABLED_SETTING = "ELIZA_SECRET_SWAP_ENABLED";
export const SECRET_SWAP_EXEMPT_VALUES_SETTING =
	"ELIZA_SECRET_SWAP_EXEMPT_VALUES";

/**
 * Honest model-param graphs are a handful of objects deep. JSON.parse still
 * admits a 20k-deep nest that then RangeError'd `substituteInValue` on
 * origin develop.
 */
export const MAX_SECRET_SWAP_WALK_DEPTH = 64;
export const MAX_SECRET_SWAP_WALK_NODES = 100_000;
export const SECRET_SWAP_UNBOUNDED = "SECRET_SWAP_UNBOUNDED";

type SecretSwapWalkContext = {
	visits: number;
	visiting: WeakSet<object>;
};

function failSecretSwapUnbounded(
	context: Record<string, unknown>,
	cause?: unknown,
): never {
	throw new ElizaError("Secret-swap value exceeds the walk budget", {
		code: SECRET_SWAP_UNBOUNDED,
		cause,
		context,
		severity: "fatal",
	});
}

export function isSecretSwapUnbounded(error: unknown): boolean {
	return error instanceof ElizaError && error.code === SECRET_SWAP_UNBOUNDED;
}

function inspectSwap<T>(operation: string, inspect: () => T): T {
	try {
		return inspect();
	} catch (cause) {
		// error-policy:J2 Proxy inspection failures wrap with cause as unbounded.
		failSecretSwapUnbounded({ inspection: operation }, cause);
	}
}

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
	// Fail closed through BufferUtils.randomBytes (the W1-066 policy): a nonce
	// from a predictable Math.random() fallback could be recovered from observed
	// outputs, making placeholders forgeable and re-enabling restore-hijack.
	const bytes = BufferUtils.randomBytes(8);
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
		// error-policy:J3 custom patterns are untrusted configuration; an invalid
		// expression is excluded from the compiled detector set.
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

function createSecretSwapWalkContext(): SecretSwapWalkContext {
	return { visits: 0, visiting: new WeakSet<object>() };
}

function reserveSecretSwapVisits(ctx: SecretSwapWalkContext, count = 1): void {
	if (
		!Number.isSafeInteger(count) ||
		count < 0 ||
		count > MAX_SECRET_SWAP_WALK_NODES - ctx.visits
	) {
		failSecretSwapUnbounded({
			visits: ctx.visits,
			requestedVisits: count,
			maxNodes: MAX_SECRET_SWAP_WALK_NODES,
		});
	}
	ctx.visits += count;
}

function ownValueDescriptor(
	value: object,
	key: string | number,
): PropertyDescriptor | undefined {
	const descriptor = inspectSwap("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, key),
	);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) {
		failSecretSwapUnbounded({
			accessor: true,
			numericKey: typeof key === "number",
		});
	}
	return descriptor;
}

function isSecretSwapArray(value: object): boolean {
	return inspectSwap("isArray", () => Array.isArray(value));
}

function isSecretSwapPlainObject(
	value: object,
): value is Record<string, unknown> {
	return (
		inspectSwap("getPrototypeOf", () => Object.getPrototypeOf(value)) ===
		Object.prototype
	);
}

function ownArrayLength(value: object): number {
	const descriptor = inspectSwap("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, "length"),
	);
	if (
		!descriptor ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "number" ||
		!Number.isSafeInteger(descriptor.value) ||
		descriptor.value < 0
	) {
		failSecretSwapUnbounded({ invalidArrayLength: true });
	}
	return descriptor.value;
}

function defineSecretSwapValue(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function walkSecretSwapValue(
	value: unknown,
	depth: number,
	ctx: SecretSwapWalkContext,
	mapString: (text: string) => string,
): unknown {
	if (typeof value === "string") {
		return mapString(value);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (depth > MAX_SECRET_SWAP_WALK_DEPTH) {
		failSecretSwapUnbounded({
			depth,
			maxDepth: MAX_SECRET_SWAP_WALK_DEPTH,
		});
	}
	if (ctx.visiting.has(value)) {
		failSecretSwapUnbounded({ cycle: true });
	}
	reserveSecretSwapVisits(ctx);
	ctx.visiting.add(value);
	try {
		if (isSecretSwapArray(value)) {
			const size = ownArrayLength(value);
			// Reserve every logical slot before scanning descriptors or allocating the
			// output. Sparse arrays otherwise bypass a per-value visit counter.
			reserveSecretSwapVisits(ctx, size);
			const next = new Array<unknown>(size);
			for (let index = 0; index < size; index += 1) {
				const descriptor = ownValueDescriptor(value, index);
				if (!descriptor) continue;
				next[index] = walkSecretSwapValue(
					descriptor.value,
					depth + 1,
					ctx,
					mapString,
				);
			}
			return next;
		}
		if (!isSecretSwapPlainObject(value)) {
			return value;
		}
		const next: Record<string, unknown> = {};
		const keys = inspectSwap("ownKeys", () => Reflect.ownKeys(value));
		// Charge reflection work up front, including symbols and non-enumerable
		// keys that still require inspection before they can be skipped.
		reserveSecretSwapVisits(ctx, keys.length);
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const descriptor = inspectSwap("getOwnPropertyDescriptor", () =>
				Object.getOwnPropertyDescriptor(value, key),
			);
			if (!descriptor?.enumerable) continue;
			if (!("value" in descriptor)) {
				failSecretSwapUnbounded({ accessor: true });
			}
			defineSecretSwapValue(
				next,
				key,
				walkSecretSwapValue(descriptor.value, depth + 1, ctx, mapString),
			);
		}
		return next;
	} finally {
		ctx.visiting.delete(value);
	}
}

export class SecretSwapSession {
	private readonly valueToEntry = new Map<string, SecretSwapEntry>();
	private readonly placeholderToEntry = new Map<string, SecretSwapEntry>();
	private readonly exemptValues: ReadonlySet<string>;
	private readonly disabledKinds: ReadonlySet<string>;
	/**
	 * Longest token (secret value or minted placeholder) the session holds,
	 * maintained incrementally as entries are added. The streaming guard
	 * ({@link ./guarded-stream}) reads this to size its carry-over window: a known
	 * secret that arrives split across two chunks must be held whole, so the guard
	 * never emits a chunk shorter than the longest value it might straddle.
	 */
	private maxToken = 0;
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

	/** Length of the longest value/placeholder held (0 when empty). */
	get maxTokenLength(): number {
		return this.maxToken;
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
		return walkSecretSwapValue(
			value,
			0,
			createSecretSwapWalkContext(),
			(text) => this.substituteText(text),
		) as T;
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
		return walkSecretSwapValue(
			value,
			0,
			createSecretSwapWalkContext(),
			(text) => this.restoreText(text, options),
		) as T;
	}

	assertNoUnresolvedPlaceholders(value: unknown): void {
		const serialized =
			typeof value === "string" ? value : JSON.stringify(value);
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
		this.maxToken = Math.max(
			this.maxToken,
			entry.value.length,
			entry.placeholder.length,
		);
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
