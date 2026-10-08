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
	const lower = trimmed.toLowerCase();
	// zh-TW, zh-HK, and zh-Hant are Traditional Chinese. The only Chinese
	// reply language is zh-CN.
	if (lower === "zh" || lower.startsWith("zh-")) {
		return "zh-CN";
	}
	if (lower.startsWith("ko")) {
		return "ko";
	}
	if (lower.startsWith("es")) {
		return "es";
	}
	if (lower.startsWith("pt")) {
		return "pt";
	}
	if (lower.startsWith("vi")) {
		return "vi";
	}
	if (lower.startsWith("tl") || lower.startsWith("fil")) {
		return "tl";
	}
	if (lower === "ja" || lower.startsWith("ja-")) {
		return "ja";
	}
	return DEFAULT_CHARACTER_LANGUAGE;
}
