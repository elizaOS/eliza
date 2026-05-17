import type { UiTheme } from "../../state/persistence";
/** Minimal translator function type. */
export type ThemeTranslatorFn = (key: string) => string;
export interface ThemeToggleProps {
  uiTheme: UiTheme;
  setUiTheme: (theme: UiTheme) => void;
  /** Optional translator for ARIA labels */
  t?: ThemeTranslatorFn;
  /** Optional extra className on the root */
  className?: string;
  variant?: "native" | "companion" | "titlebar";
}
export declare function ThemeToggle({
  uiTheme,
  setUiTheme,
  t: _t,
  className,
  variant: _variant,
}: ThemeToggleProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ThemeToggle.d.ts.map
