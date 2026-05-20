"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

/**
 * Dev-only keyboard shortcut to toggle theme.
 * Press Alt+Shift+T to switch between light and dark mode.
 * Renders nothing — purely a side-effect hook.
 */
export function DevThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && e.shiftKey && e.key === "T") {
        e.preventDefault();
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [resolvedTheme, setTheme]);

  return null;
}
