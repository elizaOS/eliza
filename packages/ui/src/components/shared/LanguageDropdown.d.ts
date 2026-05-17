import type { UiLanguage } from "../../i18n/messages";
/** Minimal translator function type. Receive key, return string. */
export type TranslatorFn = (key: string) => string;
/** Language metadata with flag emoji and native label. */
export declare const LANGUAGES: {
  id: UiLanguage;
  flag: string;
  label: string;
}[];
export declare const LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME =
  "!h-11 !min-h-11 !rounded-xl !px-3.5";
export interface LanguageDropdownProps {
  uiLanguage: UiLanguage;
  setUiLanguage: (language: UiLanguage) => void;
  /** Optional translator for ARIA labels */
  t?: TranslatorFn;
  /** Optional extra className on the root */
  className?: string;
  /** Optional extra className on the trigger button */
  triggerClassName?: string;
  variant?: "native" | "companion" | "titlebar";
  menuPlacement?: "bottom-end" | "top-end";
}
export declare function LanguageDropdown({
  uiLanguage,
  setUiLanguage,
  t,
  className,
  triggerClassName,
  variant,
  menuPlacement,
}: LanguageDropdownProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=LanguageDropdown.d.ts.map
