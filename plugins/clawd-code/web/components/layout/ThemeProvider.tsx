"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useChatStore } from "@/lib/store";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: () => {},
  resolvedTheme: "dark",
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { settings, updateSettings } = useChatStore();
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const resolve = () => {
      if (settings.theme === "system") {
        return mediaQuery.matches ? "dark" : "light";
      }
      return settings.theme;
    };

    const apply = () => {
      const resolved = resolve();
      setResolvedTheme(resolved);
      // Dark is the default; add `.light` class for light theme
      document.documentElement.classList.toggle("light", resolved === "light");
    };

    apply();
    mediaQuery.addEventListener("change", apply);
    return () => mediaQuery.removeEventListener("change", apply);
  }, [settings.theme]);

  const setTheme = (theme: Theme) => {
    updateSettings({ theme });
  };

  return (
    <ThemeContext.Provider value={{ theme: settings.theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
