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
};

const MIN_SWAP_VALUE_LENGTH = 8;
const PLACEHOLDER_PREFIX = "__ELIZA_SECRET_";
const PLACEHOLDER_PATTERN = /__ELIZA_SECRET_\d+__/g;
const PII_PATTERNS: readonly RegExp[] = [
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
	/\b\d{3}-\d{2}-\d{4}\b/g,
	/\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
];

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

	constructor(options: SecretSwapSessionOptions = {}) {
		this.exemptValues = new Set(
			[...(options.exemptValues ?? [])]
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
		const detected = [
			...collectMatches(result, SECRET_PATTERNS, this.exemptValues),
			...collectMatches(result, PII_PATTERNS, this.exemptValues),
		].sort((a, b) => b.length - a.length);

		for (const value of detected) {
			this.entryForValue(value, "detected");
		}
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
		const restored = text.replace(PLACEHOLDER_PATTERN, (placeholder) => {
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
		const placeholders = [
			...new Set(serialized.match(PLACEHOLDER_PATTERN) ?? []),
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
			placeholder: `${PLACEHOLDER_PREFIX}${this.valueToEntry.size + 1}__`,
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
