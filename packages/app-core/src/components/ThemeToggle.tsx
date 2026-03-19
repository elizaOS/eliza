/**
 * ThemeToggle — day/night switch for light/dark theme.
 *
 * Fully props-driven; no app context dependency. Takes the current theme
 * and a setter from the caller. Works in both "native" and "companion"
 * visual variants.
 */

import { useCallback } from "react";
import type { UiTheme } from "../state/persistence";

/** Minimal translator function type. */
export type ThemeTranslatorFn = (key: string) => string;

export interface ThemeToggleProps {
  uiTheme: UiTheme;
  setUiTheme: (theme: UiTheme) => void;
  /** Optional translator for ARIA labels */
  t?: ThemeTranslatorFn;
  /** Optional extra className on the root */
  className?: string;
  variant?: "native" | "companion";
}

/** Sun icon SVG for light mode indicator */
function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

/** Moon icon SVG for dark mode indicator */
function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function ThemeToggle({
  uiTheme,
  setUiTheme,
  t: _t,
  className,
  variant: _variant = "native",
}: ThemeToggleProps) {
  const isDark = uiTheme === "dark";

  const handleToggle = useCallback(() => {
    setUiTheme(isDark ? "light" : "dark");
  }, [isDark, setUiTheme]);

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={handleToggle}
      onPointerDown={(event) => event.stopPropagation()}
      className={`inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] border border-border/50 bg-bg/50 backdrop-blur-md cursor-pointer text-sm leading-none hover:border-accent hover:text-txt font-medium hover:-translate-y-0.5 transition-all duration-300 hover:shadow-[0_0_15px_rgba(var(--accent),0.5)] active:scale-95 rounded-xl text-txt shadow-sm ${className ?? ""}`}
      data-testid="theme-toggle"
      data-no-camera-drag="true"
    >
      {isDark ? (
        <SunIcon className="w-5 h-5" />
      ) : (
        <MoonIcon className="w-5 h-5" />
      )}
    </button>
  );
}
