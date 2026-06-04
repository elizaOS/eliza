import type { UiLanguage } from "../../i18n/messages";

/** Language metadata with flag emoji and native label. */
export const LANGUAGES: { id: UiLanguage; flag: string; label: string }[] = [
  { id: "en", flag: "\u{1F1FA}\u{1F1F8}", label: "English" },
  { id: "zh-CN", flag: "\u{1F1E8}\u{1F1F3}", label: "中文" },
  { id: "ko", flag: "\u{1F1F0}\u{1F1F7}", label: "한국어" },
  { id: "es", flag: "\u{1F1EA}\u{1F1F8}", label: "Español" },
  { id: "pt", flag: "\u{1F1E7}\u{1F1F7}", label: "Português" },
  { id: "vi", flag: "\u{1F1FB}\u{1F1F3}", label: "Tiếng Việt" },
  { id: "tl", flag: "\u{1F1F5}\u{1F1ED}", label: "Tagalog" },
  { id: "ja", flag: "\u{1F1EF}\u{1F1F5}", label: "日本語" },
];

export const LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME =
  "!h-11 !min-h-11 !rounded-sm !px-3.5";
