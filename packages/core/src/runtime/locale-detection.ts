/**
 * Lightweight locale detection for the planner's `localizedExamples` wiring.
 *
 * This helper exists for one job: turn an arbitrary recent user message into
 * a best-guess locale tag when the canonical source (`OwnerFactStore.locale`)
 * isn't populated yet. It is *not* a general-purpose language identifier —
 * it favours simple character-set + common-word checks that run synchronously
 * with no LLM calls.
 *
 * Priority order applied by `resolveOwnerLocale`:
 *   1. `ownerLocale` (canonical, when the owner has set it)
 *   2. `detectLocaleFromText(recentMessage)` (heuristic on most-recent message)
 *   3. `defaultLocale` (caller-provided, defaults to `"en"`)
 */

/**
 * BCP-47-ish locale tag the catalog and registry agree on. We intentionally
 * keep the surface narrow to the locales we actually translate for; callers
 * that need more freedom can pass any string and it will pass through.
 */
export type SupportedLocale = "en" | "es" | "fr" | "ja" | "zh-Hans";

const ZH_HANS_RANGE = /[一-鿿]/;
const JAPANESE_KANA_RANGE = /[぀-ヿ]/;

const SPANISH_HINT_WORDS = new Set([
	"hola",
	"gracias",
	"por",
	"favor",
	"que",
	"qué",
	"cómo",
	"como",
	"dónde",
	"donde",
	"cuándo",
	"cuando",
	"buenos",
	"buenas",
	"días",
	"tardes",
	"noches",
	"está",
	"estoy",
	"estás",
	"recordar",
	"recordame",
	"recuérdame",
	"agrega",
	"agregar",
	"añade",
	"añadir",
	"para",
	"mañana",
	"hoy",
	"ayer",
	"semana",
]);

const FRENCH_HINT_WORDS = new Set([
	"bonjour",
	"merci",
	"oui",
	"non",
	"très",
	"avec",
	"pour",
	"dans",
	"mais",
	"ajoute",
	"ajouter",
	"rappelle",
	"rappelle-moi",
	"matin",
	"soir",
	"semaine",
	"aujourd",
	"aujourd'hui",
	"demain",
	"hier",
	"être",
	"avoir",
]);

const SPANISH_DIACRITICS = /[ñ¿¡áéíóúüÑ¿¡ÁÉÍÓÚÜ]/;
const FRENCH_DIACRITICS = /[àâäæçéèêëîïôœùûüÿÀÂÄÆÇÉÈÊËÎÏÔŒÙÛÜŸ]/;

/**
 * Returns the best-guess locale for `text`, or `null` when the heuristic has
 * no signal. Empty / whitespace input → `null`.
 */
export function detectLocaleFromText(
	text: string | null | undefined,
): SupportedLocale | string | null {
	if (typeof text !== "string") {
		return null;
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return null;
	}

	// CJK character-set checks first — these are the strongest signals.
	if (JAPANESE_KANA_RANGE.test(trimmed)) {
		return "ja";
	}
	// Han characters without kana → simplified Chinese for our purposes.
	// (Traditional Chinese isn't in our supported pack list yet; if both
	// scripts appear we still prefer `zh-Hans` as the closest match.)
	if (ZH_HANS_RANGE.test(trimmed)) {
		return "zh-Hans";
	}

	const lower = trimmed.toLowerCase();
	const wordTokens = lower.match(/[\p{L}'-]+/gu) ?? [];

	let spanishScore = 0;
	let frenchScore = 0;

	for (const word of wordTokens) {
		if (SPANISH_HINT_WORDS.has(word)) {
			spanishScore += 1;
		}
		if (FRENCH_HINT_WORDS.has(word)) {
			frenchScore += 1;
		}
	}

	// Diacritics are weaker but disambiguating signals.
	if (SPANISH_DIACRITICS.test(trimmed)) {
		spanishScore += 1;
	}
	if (FRENCH_DIACRITICS.test(trimmed)) {
		frenchScore += 1;
	}

	if (spanishScore === 0 && frenchScore === 0) {
		return null;
	}
	if (spanishScore > frenchScore) {
		return "es";
	}
	if (frenchScore > spanishScore) {
		return "fr";
	}
	// Tied score with non-zero hits → ambiguous, abstain.
	return null;
}

export interface ResolveOwnerLocaleOptions {
	/** Canonical locale from `OwnerFactStore.locale`. Wins when present. */
	ownerLocale?: string | null;
	/** Most-recent user message used as the heuristic fallback. */
	recentMessage?: string | null;
	/** Caller-provided default. Defaults to `"en"` when omitted. */
	defaultLocale?: string;
}

/**
 * Apply the priority order and return a non-empty locale string.
 * Never returns `""` or `null` — the resolver always has *some* locale to
 * key the registry by; callers that need an absent-locale signal should
 * compare against `defaultLocale` themselves.
 */
export function resolveOwnerLocale(opts: ResolveOwnerLocaleOptions): string {
	const owner =
		typeof opts.ownerLocale === "string" ? opts.ownerLocale.trim() : "";
	if (owner.length > 0) {
		return owner;
	}
	const detected = detectLocaleFromText(opts.recentMessage);
	if (detected) {
		return detected;
	}
	const fallback =
		typeof opts.defaultLocale === "string" && opts.defaultLocale.trim()
			? opts.defaultLocale.trim()
			: "en";
	return fallback;
}
