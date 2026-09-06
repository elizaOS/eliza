/**
 * Loads and shares marketing locale chunks across provider instances. Cache
 * entries are published only after imports succeed, including valid empty
 * dictionaries. Browsers can retain failed imports in their module map, so
 * retrying a failed chunk requires the host error boundary to reload the page.
 */
import type { MessageDict, UiLanguage } from "./I18nProvider";

const loaders = {
  "zh-CN": () => import("../i18n/locales/zh-CN.json"),
  ko: () => import("../i18n/locales/ko.json"),
  es: () => import("../i18n/locales/es.json"),
  pt: () => import("../i18n/locales/pt.json"),
  vi: () => import("../i18n/locales/vi.json"),
  tl: () => import("../i18n/locales/tl.json"),
  ja: () => import("../i18n/locales/ja.json"),
};
const messages = new Map<UiLanguage, MessageDict>();
const inflight = new Map<UiLanguage, Promise<MessageDict>>();

export function loadLanguageMessages(lang: UiLanguage): Promise<MessageDict> {
  if (lang === "en") return Promise.resolve({});
  const cached = messages.get(lang);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(lang);
  if (pending) return pending;
  const request = loaders[lang]()
    .then((module) => {
      messages.set(lang, module.default);
      return module.default;
    })
    .finally(() => {
      inflight.delete(lang);
    });
  inflight.set(lang, request);
  return request;
}
