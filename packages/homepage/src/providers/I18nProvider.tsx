/**
 * Minimal i18n provider for the elizaOS marketing homepage.
 *
 * English is inlined as `defaultValue` at every call site; non-English locales
 * load lazily from `src/i18n/locales/*` while matching the hook contract used by
 * shared UI packages.
 */
import { detectClientLanguage } from "@elizaos/ui/i18n/region";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { loadLanguageMessages } from "./language-messages";

export const UI_LANGUAGES = [
  "en",
  "zh-CN",
  "ko",
  "es",
  "pt",
  "vi",
  "tl",
  "ja",
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

const UI_LANGUAGE_SET = new Set<string>(UI_LANGUAGES);
const STORAGE_KEY = "elizaos.homepage.lang";

export type MessageDict = Record<string, string>;
export type TranslationVars = Record<string, unknown>;

export function normalizeLanguage(input: unknown): UiLanguage {
  if (typeof input !== "string") return DEFAULT_UI_LANGUAGE;
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_UI_LANGUAGE;
  if (UI_LANGUAGE_SET.has(trimmed)) return trimmed as UiLanguage;
  const lower = trimmed.toLowerCase();
  if (lower === "zh" || lower === "zh-cn" || lower.startsWith("zh-hans"))
    return "zh-CN";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("pt")) return "pt";
  if (lower.startsWith("vi")) return "vi";
  if (lower.startsWith("tl") || lower.startsWith("fil")) return "tl";
  if (lower.startsWith("ja")) return "ja";
  return DEFAULT_UI_LANGUAGE;
}

function interpolate(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const raw = vars[key];
    if (raw == null) return "";
    return String(raw);
  });
}

export type Translator = (key: string, vars?: TranslationVars) => string;

function createTranslator(dict: MessageDict): Translator {
  return (key, vars) => {
    const defaultValue =
      typeof vars?.defaultValue === "string" && vars.defaultValue.trim()
        ? vars.defaultValue
        : undefined;
    const template = dict[key] ?? defaultValue ?? key;
    return interpolate(template, vars);
  };
}

export interface I18nContextValue {
  lang: UiLanguage;
  setLang: (lang: UiLanguage | string) => void;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function resolveInitialLang(): UiLanguage {
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
    // storage disabled — fall through
  }
  return detectClientLanguage() ?? DEFAULT_UI_LANGUAGE;
}

export interface I18nProviderProps {
  initialLang?: UiLanguage;
  children: ReactNode;
}

export function I18nProvider({
  initialLang,
  children,
}: I18nProviderProps): React.JSX.Element {
  const [lang, setLangState] = useState<UiLanguage>(
    initialLang ?? resolveInitialLang(),
  );

  const [loaded, setLoaded] = useState<{
    lang: UiLanguage;
    messages: MessageDict;
  } | null>(null);
  const [failure, setFailure] = useState<{
    lang: UiLanguage;
    error: Error;
  } | null>(null);

  useEffect(() => {
    let current = true;
    loadLanguageMessages(lang).then(
      (messages) => {
        if (current) setLoaded({ lang, messages });
      },
      (cause: unknown) => {
        // error-policy:J1 async import failures enter the host's React error boundary on render.
        if (current)
          setFailure({
            lang,
            error: Object.assign(
              new Error(`Could not load homepage language ${lang}`),
              { cause },
            ),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [lang]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    if (root && root.lang !== lang) root.lang = lang;
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
    };
    return {
      lang,
      setLang: next,
      t: createTranslator(loaded?.lang === lang ? loaded.messages : {}),
    };
  }, [lang, loaded]);

  if (failure?.lang === lang) throw failure.error;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside <I18nProvider>");
  }
  return ctx;
}

export function useT(): Translator {
  return useI18n().t;
}
