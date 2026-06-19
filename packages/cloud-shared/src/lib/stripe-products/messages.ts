/**
 * Per-locale Stripe / x402 product copy resolver.
 *
 * Returns the product message catalog for a given locale code, falling back to
 * English when unknown. Only `product_data.name` and `product_data.description`
 * style fields belong here — `statement_descriptor` is Stripe-regulated and
 * must stay short ASCII at the call site.
 */

import { stripeProductMessages as en, type StripeProductMessages } from "./locales/en";
import { stripeProductMessages as es } from "./locales/es";
import { stripeProductMessages as ja } from "./locales/ja";
import { stripeProductMessages as ko } from "./locales/ko";
import { stripeProductMessages as pt } from "./locales/pt";
import { stripeProductMessages as tl } from "./locales/tl";
import { stripeProductMessages as vi } from "./locales/vi";
import { stripeProductMessages as zhCN } from "./locales/zh-CN";

const CATALOGS: Record<string, StripeProductMessages> = {
  en,
  es,
  ja,
  ko,
  pt,
  tl,
  vi,
  "zh-CN": zhCN,
};

export type SupportedStripeProductLocale = keyof typeof CATALOGS;

export function getStripeProductMessages(locale?: string | null): StripeProductMessages {
  if (!locale) return en;
  if (locale in CATALOGS) return CATALOGS[locale];
  const primary = locale.split("-")[0];
  if (primary in CATALOGS) return CATALOGS[primary];
  return en;
}

export type { StripeProductMessages };
