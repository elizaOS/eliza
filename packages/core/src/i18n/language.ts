/**
 * Canonical UI language codes and BCP-47 → supported-language normalization.
 * Pure, React-free, and dependency-free so Node route handlers (content
 * negotiation in `@elizaos/app`) can normalize `Accept-Language` without
 * pulling the renderer's message dictionaries. `@elizaos/ui/i18n` re-exports
 * these and layers the message-dictionary lookup on top.
 */

export const UI_LANGUAGES = [
	"en",
	"zh-CN",
	"ko",
	"es",
	"pt",
	"vi",
	"tl",
	"ja",
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

const UI_LANGUAGE_SET = new Set<string>(UI_LANGUAGES);

/**
 * Map an arbitrary language tag (or non-string input) onto one of the
 * supported {@link UI_LANGUAGES}, falling back to {@link DEFAULT_UI_LANGUAGE}.
 */
export function normalizeLanguage(input: unknown): UiLanguage {
	if (typeof input !== "string") return DEFAULT_UI_LANGUAGE;
	const trimmed = input.trim();
	if (!trimmed) return DEFAULT_UI_LANGUAGE;
	if (UI_LANGUAGE_SET.has(trimmed)) return trimmed as UiLanguage;

	const lower = trimmed.toLowerCase();
	// zh-TW, zh-HK, and zh-Hant are Traditional Chinese. The only Chinese UI
	// is zh-CN, which is also the country fallback for TW/HK/MO.
	if (lower === "zh" || lower.startsWith("zh-")) {
		return "zh-CN";
	}
	if (lower === "en" || lower.startsWith("en-")) {
		return "en";
	}
	if (lower === "ko" || lower.startsWith("ko-")) return "ko";
	if (lower === "es" || lower.startsWith("es-")) return "es";
	if (lower === "pt" || lower.startsWith("pt-")) return "pt";
	if (lower === "vi" || lower.startsWith("vi-")) return "vi";
	if (
		lower === "tl" ||
		lower.startsWith("tl-") ||
		lower === "fil" ||
		lower.startsWith("fil-")
	)
		return "tl";
	if (lower === "ja" || lower.startsWith("ja-")) return "ja";
	return DEFAULT_UI_LANGUAGE;
}
