/**
 * Per-locale SEO copy resolver. Returns the SEO message catalog for a given
 * locale code, falling back to English when unknown.
 */

import { seoMessages as en, type SeoMessages } from "./locales/en";
import { seoMessages as es } from "./locales/es";
import { seoMessages as ja } from "./locales/ja";
import { seoMessages as ko } from "./locales/ko";
import { seoMessages as pt } from "./locales/pt";
import { seoMessages as tl } from "./locales/tl";
import { seoMessages as vi } from "./locales/vi";
import { seoMessages as zhCN } from "./locales/zh-CN";

const CATALOGS: Record<string, SeoMessages> = {
  en,
  es,
  ja,
  ko,
  pt,
  tl,
  vi,
  "zh-CN": zhCN,
};

export type SupportedSeoLocale = keyof typeof CATALOGS;

/**
 * Returns the SEO catalog for a locale code. Unknown locales fall back to
 * English. Accepts `pt-BR`, `zh-CN`, etc.
 */
export function getSeoMessages(locale?: string | null): SeoMessages {
  if (!locale) return en;
  if (locale in CATALOGS) return CATALOGS[locale];
  const primary = locale.split("-")[0];
  if (primary in CATALOGS) return CATALOGS[primary];
  return en;
}

export type { SeoMessages };
