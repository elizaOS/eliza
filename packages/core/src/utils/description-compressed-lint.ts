/**
 * Lint helper for hand-authored `descriptionCompressed` values on actions and
 * providers. The runtime auto-fills `descriptionCompressed` via
 * `compressPromptDescription`, but plugin authors often hand-author the field
 * for higher-quality routing prompts. This helper enforces the same rules the
 * compressor would have applied:
 *
 * - Non-empty, trimmed.
 * - At most {@link MAX_DESCRIPTION_LENGTH} characters.
 * - No filler phrases that the compressor strips (`PHRASE_REPLACEMENTS`).
 * - No long-form word forms that the compressor abbreviates
 *   (`WORD_REPLACEMENTS` — `messages`, `configuration`, etc.).
 * - Starts with an imperative verb, not a stative one (`Helps`, `Allows`,
 *   `It`, `This`, `Should`).
 *
 * Runs as ad-hoc tooling — see `scripts/lint-description-compressed.mjs`. The
 * helper is intentionally pure: caller decides exit-code semantics.
 */

export const MAX_DESCRIPTION_LENGTH = 160;

/**
 * Banned phrases — must be a substring of one of the keys in
 * `PHRASE_REPLACEMENTS` in `prompt-compression.ts`. Each entry is matched as
 * a case-insensitive whole-word phrase so we don't false-positive on
 * substrings that happen to live inside larger words.
 */
const BANNED_PHRASES: ReadonlyArray<{ phrase: string; pattern: RegExp }> = [
	{ phrase: "in order to", pattern: /\bin order to\b/i },
	{ phrase: "please", pattern: /\bplease\b/i },
	{ phrase: "simply", pattern: /\bsimply\b/i },
	{ phrase: "basically", pattern: /\bbasically\b/i },
	{ phrase: "actually", pattern: /\bactually\b/i },
	{ phrase: "currently", pattern: /\bcurrently\b/i },
	{ phrase: "this action", pattern: /\bthis action\b/i },
	{ phrase: "use this action", pattern: /\buse this action\b/i },
	{ phrase: "the user", pattern: /\bthe user\b/i },
	{ phrase: "the agent", pattern: /\bthe agent\b/i },
];

/**
 * Banned long-form word forms. The compressor would have replaced these with
 * shorter equivalents — flag any that survived.
 */
const BANNED_WORDS: ReadonlyArray<{
	word: string;
	pattern: RegExp;
	replacement: string;
}> = [
	{ word: "messages", pattern: /\bmessages\b/i, replacement: "msgs" },
	{
		word: "configuration",
		pattern: /\bconfiguration\b/i,
		replacement: "config",
	},
];

/**
 * Stative / non-imperative leading verbs we want to discourage. The
 * compressor's `LEADING_VERB_REPLACEMENTS` already converts `Provides` →
 * `Provide`, `Retrieves` → `Get`, etc., but a hand-authored value should
 * already be in imperative form, so we flag the rest of the family directly.
 */
const NON_IMPERATIVE_LEADING_WORDS: ReadonlySet<string> = new Set([
	"It",
	"This",
	"Helps",
	"Allows",
	"Should",
	"Provides",
	"Retrieves",
	"Returns",
	"Generates",
	"Creates",
	"Updates",
	"Deletes",
	"Sends",
	"Extracts",
	"Identifies",
	"Summarizes",
	"Compresses",
	"Automatically",
]);

export interface LintDescriptionCompressedResult {
	readonly ok: boolean;
	readonly violations: string[];
}

/**
 * Validate a hand-authored `descriptionCompressed` value. Returns
 * `{ ok: true, violations: [] }` on a clean input, or
 * `{ ok: false, violations: [...] }` listing every rule that fired.
 *
 * The function is pure and never throws: callers can treat it as a
 * yes/no boundary check.
 */
export function lintDescriptionCompressed(
	text: string,
): LintDescriptionCompressedResult {
	const violations: string[] = [];

	if (typeof text !== "string" || !text.trim()) {
		violations.push("empty: descriptionCompressed must be non-empty");
		return { ok: false, violations };
	}

	const value = text;

	if (value.length > MAX_DESCRIPTION_LENGTH) {
		violations.push(
			`length: descriptionCompressed is ${value.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
		);
	}

	for (const { phrase, pattern } of BANNED_PHRASES) {
		if (pattern.test(value)) {
			violations.push(
				`banned-phrase: descriptionCompressed contains "${phrase}" (compressor would strip/replace)`,
			);
		}
	}

	for (const { word, pattern, replacement } of BANNED_WORDS) {
		if (pattern.test(value)) {
			violations.push(
				`banned-word: descriptionCompressed uses "${word}" (use "${replacement}" instead)`,
			);
		}
	}

	const firstWordMatch = value.trim().match(/^([A-Za-z][A-Za-z0-9_-]*)/);
	if (firstWordMatch) {
		const firstWord = firstWordMatch[1];
		if (NON_IMPERATIVE_LEADING_WORDS.has(firstWord)) {
			violations.push(
				`non-imperative: descriptionCompressed starts with "${firstWord}" — use an imperative verb (e.g. "Send", "Get", "List")`,
			);
		}
	}

	return { ok: violations.length === 0, violations };
}
