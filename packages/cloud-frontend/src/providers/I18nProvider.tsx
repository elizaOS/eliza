import {
  createTranslator,
  DEFAULT_UI_LANGUAGE,
  normalizeLanguage,
  type UiLanguage,
} from "@elizaos/ui/i18n/index";
import { ensureLanguageLoaded } from "@elizaos/ui/i18n/messages";
import { detectClientLanguage } from "@elizaos/ui/i18n/region";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const STORAGE_KEY = "cloud.lang";

export interface I18nContextValue {
  lang: UiLanguage;
  setLang: (lang: UiLanguage | string) => void;
  t: ReturnType<typeof createTranslator>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Resolve the initial UI language synchronously before React mounts so the
 * first paint matches the user's persisted preference.
 *
 * Resolution order:
 *   1. ?lang= URL query (overrides everything; useful for QA / Playwright)
 *   2. localStorage.cloud.lang
 *   3. browser languages + region subtag (detectClientLanguage)
 *   4. DEFAULT_UI_LANGUAGE
 *
 * Account-level preference from /api/v1/users/me is wired in via
 * useEffect inside the provider once the Steward session resolves.
 */
export function resolveInitialLang(): UiLanguage {
  if (typeof window === "undefined") return DEFAULT_UI_LANGUAGE;
  try {
    const url = new URL(window.location.href);
    const query = url.searchParams.get("lang");
    if (query) return normalizeLanguage(query);
  } catch {
    // location parse failures fall through to next layer
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeLanguage(stored);
  } catch {
    // SSR or storage disabled — fall through
  }
  return detectClientLanguage() ?? DEFAULT_UI_LANGUAGE;
}

export interface I18nProviderProps {
  initialLang?: UiLanguage;
  children: ReactNode;
}

/**
 * Provider for cloud-frontend i18n. Wraps the existing `@elizaos/ui` `t()`
 * system with React context + persistence. Components consume via `useT()`.
 *
 * The dictionary for the active language is lazy-loaded on mount and on
 * every change; English is bundled eagerly.
 */
export function I18nProvider({
  initialLang,
  children,
}: I18nProviderProps): React.JSX.Element {
  const [lang, setLangState] = useState<UiLanguage>(
    initialLang ?? resolveInitialLang(),
  );

  useEffect(() => {
    void ensureLanguageLoaded(lang);
  }, [lang]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const root = document.documentElement;
      if (root && root.lang !== lang) root.lang = lang;
    } catch {
      // documentElement access failures are non-fatal
    }
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => {
    const next = (input: UiLanguage | string) => {
      const normalized = normalizeLanguage(input);
      try {
        window.localStorage.setItem(STORAGE_KEY, normalized);
      } catch {
        // storage disabled — keep in-memory state
      }
      setLangState(normalized);
      void ensureLanguageLoaded(normalized);
    };
    return {
      lang,
      setLang: next,
      t: createTranslator(lang),
    };
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Access the current language + translator. Throws if called outside an
 * `<I18nProvider>` so wiring bugs surface loudly at component mount instead
 * of at the first untranslated string.
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside <I18nProvider>");
  }
  return ctx;
}

/**
 * Convenience: most call sites only need the `t` function.
 */
export function useT(): ReturnType<typeof createTranslator> {
  return useI18n().t;
}
