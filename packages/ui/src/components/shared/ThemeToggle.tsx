import { Button } from "@elizaos/ui";
import { Moon, Sun } from "lucide-react";
import { useCallback } from "react";
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
  const resolvedClassName =
    _variant === "titlebar"
      ? `inline-flex h-[2.375rem] w-[2.375rem] min-h-[2.375rem] min-w-[2.375rem] items-center justify-center rounded-md border border-transparent !bg-transparent text-muted shadow-none ring-0 transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent ${className ?? ""}`
      : `inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt text-sm leading-none ${className ?? ""}`;

  return (
    <Button
      size="icon"
      variant="outline"
      aria-label={_t ? _t("aria.toggleTheme") : "Toggle theme"}
      onClick={handleToggle}
      onPointerDown={(event) => event.stopPropagation()}
      className={resolvedClassName}
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
