/**
 * Sensitive text redaction utilities.
 *
 * Provides functions to mask sensitive data like API keys, tokens,
 * passwords, and PEM blocks in text output before logging or display.
 *
 * Also provides secrets-aware redaction to prevent character secrets
 * from appearing in agent outputs or memories.
 *
 * @module security/redact
 */

/**
 * Mode for sensitive text redaction.
 * - "off": No redaction
 * - "tools": Redact in tool outputs
 */
export type RedactSensitiveMode = "off" | "tools";

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

// Minimum length for a secret to be considered for redaction
// Shorter values could cause false positives
const MIN_SECRET_LENGTH = 8;

/**
 * Default patterns for detecting sensitive data.
 * Matches common formats for API keys, tokens, passwords, etc.
 */
const DEFAULT_REDACT_PATTERNS: string[] = [
	// ENV-style assignments.
	String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
	// JSON fields.
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
	// CLI flags.
	String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
	// Authorization headers.
	String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	// PEM blocks.
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
	// Common token prefixes.
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
	String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
	String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
	String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
	String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
];

/**
 * Options for redacting sensitive text.
 */
export type RedactOptions = {
	/** Redaction mode */
	mode?: RedactSensitiveMode;
	/** Custom patterns to match (in addition to or instead of defaults) */
	patterns?: string[];
};

/**
 * Options for secrets-based redaction.
 */
export type SecretsRedactOptions = {
	/** Known secrets to redact (key -> secret value) */
	secrets?: Record<string, string>;
	/** Whether to also apply pattern-based redaction */
	applyPatterns?: boolean;
};

function normalizeMode(value?: string): RedactSensitiveMode {
	return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: string): RegExp | null {
	if (!raw.trim()) {
		return null;
	}
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

function resolvePatterns(value?: string[]): RegExp[] {
	const source = value?.length ? value : DEFAULT_REDACT_PATTERNS;
	return source.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function maskToken(token: string): string {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
		return "***";
	}
	const start = token.slice(0, DEFAULT_REDACT_KEEP_START);
	const end = token.slice(-DEFAULT_REDACT_KEEP_END);
	return `${start}…${end}`;
}

function redactPemBlock(block: string): string {
	const lines = block.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) {
		return "***";
	}
	return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
	if (match.includes("PRIVATE KEY-----")) {
		return redactPemBlock(match);
	}
	const filteredGroups = groups.filter(
		(value) => typeof value === "string" && value.length > 0,
	);
	const token = filteredGroups[filteredGroups.length - 1] ?? match;
	const masked = maskToken(token);
	if (token === match) {
		return masked;
	}
	return match.replace(token, masked);
}

function redactText(text: string, patterns: RegExp[]): string {
	let next = text;
	for (const pattern of patterns) {
		next = next.replace(pattern, (...args: string[]) =>
			redactMatch(args[0], args.slice(1, args.length - 2)),
		);
	}
	return next;
}

/**
 * Redact sensitive information from text.
 *
 * @param text - The text to redact
 * @param options - Redaction options
 * @returns Text with sensitive data masked
 */
export function redactSensitiveText(
	text: string,
	options?: RedactOptions,
): string {
	if (!text) {
		return text;
	}
	const resolved = options ?? { mode: DEFAULT_REDACT_MODE };
	if (normalizeMode(resolved.mode) === "off") {
		return text;
	}
	const patterns = resolvePatterns(resolved.patterns);
	if (!patterns.length) {
		return text;
	}
	return redactText(text, patterns);
}

/**
 * Redact sensitive information from tool output detail.
 *
 * Only redacts when mode is "tools" (the default).
 *
 * @param detail - The tool detail to redact
 * @returns Redacted detail
 */
export function redactToolDetail(detail: string): string {
	return redactSensitiveText(detail, { mode: "tools" });
}

/**
 * Get the default redaction patterns.
 *
 * @returns Copy of default pattern strings
 */
export function getDefaultRedactPatterns(): string[] {
	return [...DEFAULT_REDACT_PATTERNS];
}

// ============================================================================
// Secrets-Based Redaction
// ============================================================================

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact known secrets from text.
 *
 * This performs literal string replacement of known secret values,
 * ensuring they don't appear in outputs even if they don't match
 * the pattern-based detection.
 *
 * @param text - Text to redact
 * @param secrets - Map of secret names to secret values
 * @returns Text with secrets replaced by [REDACTED:name]
 */
export function redactSecrets(
	text: string,
	secrets: Record<string, string>,
): string {
	if (!text || !secrets) {
		return text;
	}

	let result = text;

	// Sort secrets by length (longest first) to avoid partial replacements
	const sortedEntries = Object.entries(secrets)
		.filter(
			([, value]) =>
				typeof value === "string" && value.length >= MIN_SECRET_LENGTH,
		)
		.sort(([, a], [, b]) => b.length - a.length);

	for (const [name, value] of sortedEntries) {
		// Create a case-sensitive regex for the exact value
		const escaped = escapeRegex(value);
		const regex = new RegExp(escaped, "g");
		result = result.replace(regex, `[REDACTED:${name}]`);
	}

	return result;
}

/**
 * Redact both known secrets and pattern-detected sensitive data.
 *
 * This combines literal secret replacement with pattern-based detection
 * for comprehensive redaction.
 *
 * @param text - Text to redact
 * @param options - Redaction options including known secrets
 * @returns Text with all sensitive data redacted
 */
export function redactWithSecrets(
	text: string,
	options: SecretsRedactOptions = {},
): string {
	if (!text) {
		return text;
	}

	let result = text;

	// First, redact known secrets (exact matches)
	if (options.secrets) {
		result = redactSecrets(result, options.secrets);
	}

	// Then apply pattern-based redaction if requested (default: true)
	if (options.applyPatterns !== false) {
		result = redactSensitiveText(result);
	}

	return result;
}

/**
 * Create a redaction function bound to specific secrets.
 *
 * This is useful for creating a redactor that can be passed around
 * and reused without needing to pass secrets each time.
 *
 * @param secrets - Map of secret names to secret values
 * @param applyPatterns - Whether to also apply pattern detection (default: true)
 * @returns Redaction function
 *
 * @example
 * ```ts
 * const redact = createSecretsRedactor(runtime.character.settings.secrets);
 * const safeText = redact(userMessage);
 * ```
 */
export function createSecretsRedactor(
	secrets: Record<string, string>,
	applyPatterns = true,
): (text: string) => string {
	return (text: string) => redactWithSecrets(text, { secrets, applyPatterns });
}

/**
 * Recursively redact secrets from an object.
 *
 * Walks through all string values in an object (including nested objects
 * and arrays) and applies secret redaction.
 *
 * @param obj - Object to redact
 * @param secrets - Map of secret names to secret values
 * @param applyPatterns - Whether to also apply pattern detection
 * @returns New object with redacted values
 */
export function redactObjectSecrets<T>(
	obj: T,
	secrets: Record<string, string>,
	applyPatterns = true,
): T {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (typeof obj === "string") {
		return redactWithSecrets(obj, { secrets, applyPatterns }) as T;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) =>
			redactObjectSecrets(item, secrets, applyPatterns),
		) as T;
	}

	if (typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = redactObjectSecrets(value, secrets, applyPatterns);
		}
		return result as T;
	}

	return obj;
}
