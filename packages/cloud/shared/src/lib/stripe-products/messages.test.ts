/** Verifies payment product copy selects the requested catalog or its documented fallback. */
import { expect, test } from "bun:test";
import { stripeProductMessages as en } from "./locales/en";
import { stripeProductMessages as es } from "./locales/es";
import { stripeProductMessages as pt } from "./locales/pt";
import { stripeProductMessages as zhCN } from "./locales/zh-CN";
import { getStripeProductMessages } from "./messages";

test.each([
  [undefined, en],
  [null, en],
  ["", en],
  ["es", es],
  ["zh-CN", zhCN],
  ["pt-BR", pt],
  ["unknown-locale", en],
] as const)("resolves locale %s to its payment copy", (locale, catalog) => {
  expect(getStripeProductMessages(locale)).toBe(catalog);
});
