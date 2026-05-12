"use client";

import * as React from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeProviderProps {
  children: React.ReactNode;
  attribute?: "class" | "data-theme";
  defaultTheme?: Theme;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
  storageKey?: string;
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: ResolvedTheme;
  systemTheme: ResolvedTheme;
}

const DEFAULT_STORAGE_KEY = "eliza-cloud-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function readStoredTheme(storageKey: string, defaultTheme: Theme): Theme {
  if (typeof window === "undefined") return defaultTheme;
  try {
    const stored = window.localStorage.getItem(storageKey);
    return isTheme(stored) ? stored : defaultTheme;
  } catch {
    return defaultTheme;
  }
}

function writeStoredTheme(storageKey: string, theme: Theme) {
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Storage can be unavailable in private browsing; the in-memory state still applies.
  }
}

function resolveTheme(
  theme: Theme,
  systemTheme: ResolvedTheme,
  enableSystem: boolean,
): ResolvedTheme {
  return theme === "system" ? (enableSystem ? systemTheme : "light") : theme;
}

function withoutTransitions(callback: () => void) {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode("*{transition:none!important;animation-duration:0s!important}"),
  );
  document.head.appendChild(style);
  callback();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => style.remove());
  });
}

export function ThemeProvider({
  children,
  attribute = "class",
  defaultTheme = "system",
  enableSystem = true,
  disableTransitionOnChange = false,
  storageKey = DEFAULT_STORAGE_KEY,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>("dark");

  React.useEffect(() => {
    setSystemTheme(getSystemTheme());
    setThemeState(readStoredTheme(storageKey, defaultTheme));
  }, [defaultTheme, storageKey]);

  React.useEffect(() => {
    if (!enableSystem || typeof window === "undefined") return;

    const mediaQuery = window.matchMedia(MEDIA_QUERY);
    const handleChange = () => setSystemTheme(mediaQuery.matches ? "dark" : "light");
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [enableSystem]);

  const resolvedTheme = resolveTheme(theme, systemTheme, enableSystem);

  React.useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      if (attribute === "class") {
        root.classList.remove("light", "dark");
        root.classList.add(resolvedTheme);
        return;
      }
      root.setAttribute(attribute, resolvedTheme);
    };

    if (disableTransitionOnChange) {
      withoutTransitions(applyTheme);
    } else {
      applyTheme();
    }
  }, [attribute, disableTransitionOnChange, resolvedTheme]);

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      setThemeState(nextTheme);
      if (typeof window !== "undefined") {
        writeStoredTheme(storageKey, nextTheme);
      }
    },
    [storageKey],
  );

  const value = React.useMemo(
    () => ({ theme, setTheme, resolvedTheme, systemTheme }),
    [theme, setTheme, resolvedTheme, systemTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
