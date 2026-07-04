import { normalizeLanguage } from "@elizaos/shared";
import {
  DEFAULT_UI_LANGUAGE,
  ensureLanguageLoaded,
  MESSAGES,
  type MessageDict,
  UI_LANGUAGES,
  type UiLanguage,
} from "./messages";

// `normalizeLanguage` (and the language-code constants below) are owned by
// @elizaos/shared so Node route handlers can normalize without the renderer's
// message dictionaries. Re-exported here to preserve the `@elizaos/ui/i18n`
// public surface.
export { normalizeLanguage };

export type TranslationVars = Record<string, unknown>;

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const raw = vars[key];
    if (raw == null) return "";
    return String(raw);
  });
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

export function createTranslator(
  lang: UiLanguage | string | null | undefined,
  defaultVars?: TranslationVars,
) {
  const normalized = normalizeLanguage(lang);
  return (key: string, vars?: TranslationVars): string => {
    const merged =
      defaultVars && vars ? { ...defaultVars, ...vars } : (vars ?? defaultVars);
    return t(normalized, key, merged);
  };
}

export {
  DEFAULT_UI_LANGUAGE,
  ensureLanguageLoaded,
  MESSAGES,
  type MessageDict,
  UI_LANGUAGES,
  type UiLanguage,
};
