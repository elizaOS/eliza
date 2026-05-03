import {
  DEFAULT_UI_LANGUAGE,
  MESSAGES,
  type MessageDict,
  UI_LANGUAGES,
  type UiLanguage,
} from "./messages";

export type TranslationVars = Record<string, unknown>;

const UI_LANGUAGE_SET = new Set<string>(UI_LANGUAGES);

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const raw = vars[key];
    if (raw == null) return "";
    return String(raw);
  });
}

export function normalizeLanguage(input: unknown): UiLanguage {
  if (typeof input !== "string") return DEFAULT_UI_LANGUAGE;
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_UI_LANGUAGE;
  if (UI_LANGUAGE_SET.has(trimmed)) return trimmed as UiLanguage;

  const lower = trimmed.toLowerCase();
  if (lower === "zh" || lower === "zh-cn" || lower.startsWith("zh-hans")) {
    return "zh-CN";
  }
  if (lower === "en" || lower.startsWith("en-")) {
    return "en";
  }
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("pt")) return "pt";
  if (lower.startsWith("vi")) return "vi";
  if (lower.startsWith("tl") || lower.startsWith("fil")) return "tl";
  return DEFAULT_UI_LANGUAGE;
}

function messageForLanguage(lang: UiLanguage): MessageDict {
  return MESSAGES[lang] ?? MESSAGES[DEFAULT_UI_LANGUAGE];
}

export function t(
  lang: UiLanguage | string | null | undefined,
  key: string,
  vars?: TranslationVars,
): string {
  const normalized = normalizeLanguage(lang);
  const localized = messageForLanguage(normalized);
  const english = messageForLanguage("en");
  const defaultValue =
    typeof vars?.defaultValue === "string" && vars.defaultValue.trim()
      ? vars.defaultValue
      : undefined;
  const template = localized[key] ?? english[key] ?? defaultValue ?? key;
  return interpolate(template, vars);
}

export function createTranslator(lang: UiLanguage | string | null | undefined) {
  const normalized = normalizeLanguage(lang);
  return (key: string, vars?: TranslationVars): string =>
    t(normalized, key, vars);
}

export {
  DEFAULT_UI_LANGUAGE,
  MESSAGES,
  type MessageDict,
  UI_LANGUAGES,
  type UiLanguage,
};
