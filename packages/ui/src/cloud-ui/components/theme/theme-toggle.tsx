"use client";

/**
 * Light/dark toggle button wired to the cloud theme provider.
 */
import { ThemeToggle as SharedThemeToggle } from "../../../components/shared/ThemeToggle";
import { useTheme } from "./theme-provider.hooks";

export function CloudThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <SharedThemeToggle
      uiTheme={resolvedTheme === "light" ? "light" : "dark"}
      setUiTheme={setTheme}
      variant="cloud"
    />
  );
}
