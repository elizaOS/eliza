import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  type UiLanguage,
} from "@elizaos/shared";
import en from "./locales/en.json" with { type: "json" };

// Canonical language codes live in @elizaos/shared (React-free, Node-safe).
// Re-exported here so renderer consumers keep importing them from
// `@elizaos/ui/i18n` alongside the message dictionaries below.
export { DEFAULT_UI_LANGUAGE, UI_LANGUAGES, type UiLanguage };

export type MessageDict = Record<string, string>;

/**
 * Locale dictionaries. Only `en` (the fallback) is bundled eagerly. All other
 * locales are dynamically imported on first use via {@link ensureLanguageLoaded}.
 *
 * Lazy loading avoids shipping ~1.5 MB raw / ~340 KB gzip of non-English JSON
 * in the main chunk for users who never switch language.
 */
export const MESSAGES: Record<UiLanguage, MessageDict> = {
  en,
  "zh-CN": {},
  ko: {},
  es: {},
  pt: {},
  vi: {},
  tl: {},
  ja: {},
};

const loaders: Record<Exclude<UiLanguage, "en">, () => Promise<MessageDict>> = {
  "zh-CN": () =>
    import("./locales/zh-CN.json").then((m) => m.default as MessageDict),
  ko: () => import("./locales/ko.json").then((m) => m.default as MessageDict),
  es: () => import("./locales/es.json").then((m) => m.default as MessageDict),
  pt: () => import("./locales/pt.json").then((m) => m.default as MessageDict),
  vi: () => import("./locales/vi.json").then((m) => m.default as MessageDict),
  tl: () => import("./locales/tl.json").then((m) => m.default as MessageDict),
  ja: () => import("./locales/ja.json").then((m) => m.default as MessageDict),
};

const inflight = new Map<UiLanguage, Promise<void>>();

/**
 * Ensure the message dictionary for `lang` is loaded. Resolves immediately if
 * the dictionary is already populated (English is always ready). Safe to call
 * multiple times concurrently — subsequent calls share the same in-flight
 * promise.
 */
export function ensureLanguageLoaded(lang: UiLanguage): Promise<void> {
  if (lang === "en") return Promise.resolve();
  const existing = MESSAGES[lang];
  if (existing && Object.keys(existing).length > 0) return Promise.resolve();
  const pending = inflight.get(lang);
  if (pending) return pending;
  const loader = loaders[lang];
  if (!loader) return Promise.resolve();
  const promise = loader()
    .then((dict) => {
      MESSAGES[lang] = dict;
    })
    .finally(() => {
      inflight.delete(lang);
    });
  inflight.set(lang, promise);
  return promise;
}
