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
import { fetchSuggestedLanguage } from "../api/i18n-locale-client";
import {
  appNameInterpolationVars,
  type BrandingConfig,
  DEFAULT_BRANDING,
} from "../config/branding";
import {
  createTranslator,
  ensureLanguageLoaded,
  normalizeLanguage,
  type UiLanguage,
} from "../i18n";
import {
  hasStoredUiLanguage,
  loadUiLanguage,
  saveUiLanguage,
} from "./persistence";

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

const TEST_TRANSLATION_CONTEXT: TranslationContextValue = {
  t: createTranslator("en"),
  uiLanguage: "en",
  setUiLanguage: () => {},
};

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
  // Captured during the initial render, before the persist effect writes the
  // (possibly browser-detected) language to storage. Distinguishes a genuine
  // first visit from a returning/explicit choice.
  const [hadStoredLanguage] = useState(hasStoredUiLanguage);
  // Bumped after async locale loads complete so consumers re-render with the
  // freshly populated MESSAGES dictionary.
  const [, setLocaleRevision] = useState(0);

  // Eagerly load the persisted locale (other than `en`) on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect; language changes flow through setUiLanguage
  useEffect(() => {
    if (uiLanguage === "en") return;
    let cancelled = false;
    void ensureLanguageLoaded(uiLanguage).then(() => {
      if (!cancelled) setLocaleRevision((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
    // Only on mount — language changes go through setUiLanguage below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setUiLanguage = useCallback(
    (language: UiLanguage) => {
      const next = normalizeLanguage(language);
      setUiLanguageRaw(next);
      void ensureLanguageLoaded(next).then(() => {
        setLocaleRevision((n) => n + 1);
      });
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

  // First-visit IP-geo fallback: when the browser gave no usable language
  // hint, ask the server (which can read the CDN geo + Accept-Language headers)
  // for a better guess. Skipped for returning users and when a browser hint
  // already resolved a non-English locale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; uiLanguage read is the initial value by design
  useEffect(() => {
    if (hadStoredLanguage || uiLanguage !== "en") return;
    let cancelled = false;
    void fetchSuggestedLanguage().then((suggested) => {
      if (!cancelled && suggested && suggested !== "en") {
        setUiLanguage(suggested);
      }
    });
    return () => {
      cancelled = true;
    };
    // Mount only.
  }, []);

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
      return TEST_TRANSLATION_CONTEXT;
    }
    throw new Error("useTranslation must be used within TranslationProvider");
  }
  return ctx;
}
