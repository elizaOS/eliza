import {
  DEFAULT_UI_LANGUAGE,
  MESSAGES,
  type MessageDict,
  UI_LANGUAGES,
  type UiLanguage,
} from "./messages";
export type TranslationVars = Record<string, unknown>;
export declare function normalizeLanguage(input: unknown): UiLanguage;
export declare function t(
  lang: UiLanguage | string | null | undefined,
  key: string,
  vars?: TranslationVars,
): string;
export declare function createTranslator(
  lang: UiLanguage | string | null | undefined,
  defaultVars?: TranslationVars,
): (key: string, vars?: TranslationVars) => string;
export {
  DEFAULT_UI_LANGUAGE,
  MESSAGES,
  type MessageDict,
  UI_LANGUAGES,
  type UiLanguage,
};
//# sourceMappingURL=index.d.ts.map
