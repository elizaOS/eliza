/**
 * ThemeToggle — day/night switch for light/dark theme.
 *
 * Fully props-driven; no app context dependency. Takes the current theme
 * and a setter from the caller. Works in both "native" and "companion"
 * visual variants.
 */

import { Button } from "@elizaos/app-core";
import { Moon, Sun } from "lucide-react";
import { useCallback } from "react";
import type { UiTheme } from "../../state/persistence";
import { SHELL_ICON_BUTTON_CLASSNAME } from "@elizaos/app-companion/ui";

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
    <Button
      size="icon"
      variant="outline"
      aria-label={_t ? _t("aria.toggleTheme") : "Toggle theme"}
      onClick={handleToggle}
      onPointerDown={(event) => event.stopPropagation()}
      className={`${SHELL_ICON_BUTTON_CLASSNAME} text-sm leading-none ${className ?? ""}`}
      data-testid="theme-toggle"
      data-no-camera-drag="true"
    >
      {isDark ? (
        <Moon className="w-5 h-5" aria-hidden />
      ) : (
        <Sun className="w-5 h-5" aria-hidden />
      )}
    </Button>
  );
}
