/**
 * Lightweight context for i18n translations.
 *
 * ~84% of components only need `{ t }` from the app context.  By isolating
 * the translator in its own context with a memoized value, those components
 * stop re-rendering whenever unrelated app state changes.
 */
import { type ReactNode } from "react";
import { type BrandingConfig } from "../config/branding";
import { type UiLanguage } from "../i18n";
export interface TranslationContextValue {
    /** Translate a key, optionally with interpolation values. */
    t: (key: string, values?: Record<string, unknown>) => string;
    uiLanguage: UiLanguage;
    /** Change the UI language. Persists to localStorage and syncs to server. */
    setUiLanguage: (language: UiLanguage) => void;
}
export declare function TranslationProvider({ children, onLanguageSyncError, branding, }: {
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
}): import("react/jsx-runtime").JSX.Element;
/**
 * Read-only access to the translator and current language.
 *
 * Components that only need `{ t }` should prefer this over `useApp()`
 * to avoid re-rendering on unrelated state changes.
 */
export declare function useTranslation(): TranslationContextValue;
//# sourceMappingURL=TranslationContext.d.ts.map