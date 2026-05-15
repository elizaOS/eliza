import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import pt from "./locales/pt.json" with { type: "json" };
import tl from "./locales/tl.json" with { type: "json" };
import vi from "./locales/vi.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };

export const UI_LANGUAGES = [
  "en",
  "zh-CN",
  "ko",
  "es",
  "pt",
  "vi",
  "tl",
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

export type MessageDict = Record<string, string>;

export const MESSAGES: Record<UiLanguage, MessageDict> = {
  en,
  "zh-CN": zhCN,
  ko,
  es,
  pt,
  vi,
  tl,
};
