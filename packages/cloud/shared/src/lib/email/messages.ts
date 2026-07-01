/**
 * Per-locale email message resolver.
 *
 * Returns the email message catalog for a given locale code, falling back to
 * English when the locale is unknown.
 */

import { type EmailMessages, emailMessages as en } from "./locales/en";
import { emailMessages as es } from "./locales/es";
import { emailMessages as ja } from "./locales/ja";
import { emailMessages as ko } from "./locales/ko";
import { emailMessages as pt } from "./locales/pt";
import { emailMessages as tl } from "./locales/tl";
import { emailMessages as vi } from "./locales/vi";
import { emailMessages as zhCN } from "./locales/zh-CN";

const CATALOGS: Record<string, EmailMessages> = {
  en,
  es,
  ja,
  ko,
  pt,
  tl,
  vi,
  "zh-CN": zhCN,
};

export type SupportedEmailLocale = keyof typeof CATALOGS;

/**
 * Returns the email message catalog for a locale code. Unknown locales fall
 * back to English. Accepts `pt-BR`, `zh-CN`, etc. (region tag preserved when it
 * matches; otherwise the primary tag is tried).
 */
export function getEmailMessages(locale?: string | null): EmailMessages {
  if (!locale) return en;
  if (locale in CATALOGS) return CATALOGS[locale];
  const primary = locale.split("-")[0];
  if (primary in CATALOGS) return CATALOGS[primary];
  return en;
}

/**
 * Interpolates `{{var}}` placeholders in a message string. Mirrors the
 * template-renderer interpolation contract so subject lines accept the same
 * variable shape as bodies.
 */
export function interpolateMessage(
  template: string,
  data: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = data[key];
    return value === undefined ? match : String(value);
  });
}

export type { EmailMessages };
