/**
 * Lightweight context for i18n translations.
 *
 * ~84% of components only need `{ t }` from the app context.  By isolating
 * the translator in its own context with a memoized value, those components
 * stop re-rendering whenever unrelated app state changes.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { client } from "../api";
import {
  appNameInterpolationVars,
  type BrandingConfig,
  DEFAULT_BRANDING,
} from "../config/branding";
import { createTranslator, normalizeLanguage, type UiLanguage } from "../i18n";
import { loadUiLanguage, saveUiLanguage } from "./persistence";

// ── Types ──────────────────────────────────────────────────────────────

export interface TranslationContextValue {
  /** Translate a key, optionally with interpolation values. */
  t: (key: string, values?: Record<string, unknown>) => string;
  uiLanguage: UiLanguage;
  /** Change the UI language. Persists to localStorage and syncs to server. */
  setUiLanguage: (language: UiLanguage) => void;
}

// ── Context ────────────────────────────────────────────────────────────

const TranslationCtx = createContext<TranslationContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────

export function TranslationProvider({
  children,
  onLanguageSyncError,
  branding,
}: {
  children: ReactNode;
  /** Optional callback when the server config sync fails. */
  onLanguageSyncError?: (language: UiLanguage) => void;
  /**
   * Branding used to seed `{{appName}}` in translated strings. Threaded
   * down explicitly because `TranslationProvider` wraps `AppProviderInner`,
   * which is where `BrandingContext.Provider` lives — `useContext`
   * here would always read the static default.
   */
  branding?: Partial<BrandingConfig>;
}) {
  const [uiLanguage, setUiLanguageRaw] = useState<UiLanguage>(loadUiLanguage);

  const setUiLanguage = useCallback(
    (language: UiLanguage) => {
      const next = normalizeLanguage(language);
      setUiLanguageRaw(next);
      if (
        "setUiLanguage" in client &&
        typeof client.setUiLanguage === "function"
      ) {
        (client.setUiLanguage as (lang: string) => void)(next);
      }
      void client.updateConfig({ ui: { language: next } }).catch(() => {
        onLanguageSyncError?.(next);
      });
    },
    [onLanguageSyncError],
  );

  // Persist + sync to client on change
  useEffect(() => {
    saveUiLanguage(uiLanguage);
    if (
      "setUiLanguage" in client &&
      typeof client.setUiLanguage === "function"
    ) {
      (client.setUiLanguage as (lang: string) => void)(uiLanguage);
    }
  }, [uiLanguage]);

  const mergedBranding = useMemo<BrandingConfig>(
    () => ({ ...DEFAULT_BRANDING, ...branding }),
    [branding],
  );
  const t = useMemo(
    () =>
      createTranslator(uiLanguage, appNameInterpolationVars(mergedBranding)),
    [uiLanguage, mergedBranding],
  );

  const value = useMemo<TranslationContextValue>(
    () => ({ t, uiLanguage, setUiLanguage }),
    [t, uiLanguage, setUiLanguage],
  );

  return (
    <TranslationCtx.Provider value={value}>{children}</TranslationCtx.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────

/**
 * Read-only access to the translator and current language.
 *
 * Components that only need `{ t }` should prefer this over `useApp()`
 * to avoid re-rendering on unrelated state changes.
 */
export function useTranslation(): TranslationContextValue {
  const ctx = useContext(TranslationCtx);
  if (!ctx) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "test") {
      return {
        t: createTranslator("en"),
        uiLanguage: "en",
        setUiLanguage: () => {},
      };
    }
    throw new Error("useTranslation must be used within TranslationProvider");
  }
  return ctx;
}
