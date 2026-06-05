/**
 * Lightweight context for i18n translations.
 *
 * ~84% of components only need `{ t }` from the app context.  By isolating
 * the translator in its own context with a memoized value, those components
 * stop re-rendering whenever unrelated app state changes.
 *
 * The context object + `useTranslation` hook live here (not in the sibling
 * .tsx) so the `TranslationProvider` component file stays React Fast
 * Refresh-compatible.
 */

import { createContext, useContext } from "react";
import { createTranslator, type UiLanguage } from "../i18n";

// ── Types ──────────────────────────────────────────────────────────────

export interface TranslationContextValue {
  /** Translate a key, optionally with interpolation values. */
  t: (key: string, values?: Record<string, unknown>) => string;
  uiLanguage: UiLanguage;
  /** Change the UI language. Persists to localStorage and syncs to server. */
  setUiLanguage: (language: UiLanguage) => void;
}

// ── Context ────────────────────────────────────────────────────────────

export const TranslationCtx = createContext<TranslationContextValue | null>(
  null,
);

const TEST_TRANSLATION_CONTEXT: TranslationContextValue = {
  t: createTranslator("en"),
  uiLanguage: "en",
  setUiLanguage: () => {},
};

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
