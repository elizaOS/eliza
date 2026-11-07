/** Data-free character language normalization and authored reply rules. */
export const CHARACTER_LANGUAGES = [
	"en",
	"zh-CN",
	"ko",
	"es",
	"pt",
	"vi",
	"tl",
	"ja",
] as const;

export type CharacterLanguage = (typeof CHARACTER_LANGUAGES)[number];

export const DEFAULT_CHARACTER_LANGUAGE: CharacterLanguage = "en";
export const LANGUAGE_REPLY_RULES: Record<CharacterLanguage, string> = {
	en: "Default to natural English unless the user clearly switches languages.",
	"zh-CN":
		"Default to natural simplified Chinese unless the user clearly switches languages.",
	ko: "Default to natural Korean unless the user clearly switches languages.",
	es: "Default to natural Spanish unless the user clearly switches languages.",
	pt: "Default to natural Brazilian Portuguese unless the user clearly switches languages.",
	vi: "Default to natural Vietnamese unless the user clearly switches languages.",
	tl: "Default to natural Tagalog unless the user clearly switches languages.",
	ja: "Default to natural Japanese unless the user clearly switches languages.",
};
export function addLanguageRule(
	system: string,
	language: CharacterLanguage,
): string {
	const rule = LANGUAGE_REPLY_RULES[language];
	return `${system} ${rule}`;
}
/**
 * Reply language for a whole primary subtag. zh-TW, zh-HK and zh-Hant are
 * Traditional Chinese; the only Chinese reply language is zh-CN.
 */
const LANGUAGE_BY_PRIMARY_SUBTAG: ReadonlyMap<string, CharacterLanguage> =
	new Map([
		["zh", "zh-CN"],
		["ko", "ko"],
		["es", "es"],
		["pt", "pt"],
		["vi", "vi"],
		["tl", "tl"],
		["fil", "tl"],
		["ja", "ja"],
	]);

export function normalizeCharacterLanguage(input: unknown): CharacterLanguage {
	if (typeof input !== "string") {
		return DEFAULT_CHARACTER_LANGUAGE;
	}
	const trimmed = input.trim();
	if (!trimmed) {
		return DEFAULT_CHARACTER_LANGUAGE;
	}
	if ((CHARACTER_LANGUAGES as readonly string[]).includes(trimmed)) {
		return trimmed as CharacterLanguage;
	}
	// Whole primary subtag only: "kok" (Konkani), "tlh" and "est" are not
	// Korean, Tagalog or Spanish. "_" is accepted as in "es_ES".
	const primary = trimmed.toLowerCase().split(/[-_]/u)[0] ?? "";
	return LANGUAGE_BY_PRIMARY_SUBTAG.get(primary) ?? DEFAULT_CHARACTER_LANGUAGE;
}
