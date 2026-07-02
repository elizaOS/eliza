/**
 * i18n provider for the app-hosted Eliza Cloud surfaces. Wraps the existing
 * `@elizaos/ui` `t()` system with React context + persistence, consumed by the
 * cloud pages via `useCloudI18n()` / `useCloudT()`.
 *
 * This is the cloud-route i18n context only; the tab/view App keeps its own
 * `@elizaos/ui` `AppProvider` translation context. They are independent.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createTranslator,
  DEFAULT_UI_LANGUAGE,
  normalizeLanguage,
  type UiLanguage,
} from "../../i18n/index";
import { ensureLanguageLoaded } from "../../i18n/messages";
import { detectClientLanguage } from "../../i18n/region";

const STORAGE_KEY = "cloud.lang";

export interface CloudI18nContextValue {
  lang: UiLanguage;
  setLang: (lang: UiLanguage | string) => void;
  t: ReturnType<typeof createTranslator>;
}

const CloudI18nContext = createContext<CloudI18nContextValue | null>(null);

/**
 * Resolve the initial UI language synchronously before React mounts so the
 * first paint matches the user's persisted preference. Resolution order:
 * `?lang=` query → `localStorage.cloud.lang` → browser language → default.
 */
export function resolveInitialCloudLang(): UiLanguage {
  if (typeof window === "undefined") return DEFAULT_UI_LANGUAGE;
  try {
    const url = new URL(window.location.href);
    const query = url.searchParams.get("lang");
    if (query) return normalizeLanguage(query);
  } catch {
    // location parse failures fall through
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeLanguage(stored);
  } catch {
    // SSR or storage disabled — fall through
  }
  return detectClientLanguage() ?? DEFAULT_UI_LANGUAGE;
}

export interface CloudI18nProviderProps {
  initialLang?: UiLanguage;
  children: ReactNode;
}

export function CloudI18nProvider({
  initialLang,
  children,
}: CloudI18nProviderProps): React.JSX.Element {
  const [lang, setLangState] = useState<UiLanguage>(
    initialLang ?? resolveInitialCloudLang(),
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

  const value = useMemo<CloudI18nContextValue>(() => {
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
    return { lang, setLang: next, t: createTranslator(lang) };
  }, [lang]);

  return (
    <CloudI18nContext.Provider value={value}>
      {children}
    </CloudI18nContext.Provider>
  );
}

export function useCloudI18n(): CloudI18nContextValue {
  const ctx = useContext(CloudI18nContext);
  if (!ctx) {
    throw new Error("useCloudI18n must be used inside <CloudI18nProvider>");
  }
  return ctx;
}

export function useCloudT(): ReturnType<typeof createTranslator> {
  return useCloudI18n().t;
}
