/**
 * Mock app/translation providers for Storybook, seeding the app-store and
 * translator so components render outside the real shell.
 */
import type { ReactNode } from "react";
import { createTranslator, type UiLanguage } from "../i18n";
import { publishAppValue } from "../state/app-store";
import {
  type TranslationContextValue,
  TranslationCtx,
} from "../state/TranslationContext.hooks";
import type { AppContextValue } from "../state/types";
import { AppContext } from "../state/useApp";

type MockAppOverrides = Partial<AppContextValue>;
type MockAgentStatus = Partial<NonNullable<AppContextValue["agentStatus"]>>;
export type MockAppOptions = Omit<MockAppOverrides, "agentStatus"> & {
  agentStatus?: MockAgentStatus | null;
};

const noop = () => {};
const noopAsync = async () => {};

const baseMockApp: Partial<AppContextValue> = {
  activeGameViewerUrl: "",
  // Branch discriminators must be explicit null, NOT left to the Proxy's
  // `noop` fallback (a truthy function) — otherwise ChatView takes its
  // terminal/inbox early-return branch ("Starting terminal…") instead of
  // rendering the composer + transcript.
  activeInboxChat: null,
  activeTerminalSessionId: null,
  agentStatus: {
    state: "stopped",
    agentName: "elizaOS Storybook",
    model: undefined,
    uptime: undefined,
    startedAt: undefined,
  },
  backendDisconnectedBannerDismissed: false,
  commandActiveIndex: 0,
  commandPaletteOpen: false,
  commandQuery: "",
  dismissBackendDisconnectedBanner: noop,
  dismissSystemWarning: noop,
  actionBanner: null,
  showActionBanner: noop,
  dismissActionBanner: noop,
  navigation: {
    scheduleAfterTabCommit: (fn: () => void) => {
      queueMicrotask(fn);
    },
  },
  // Array-typed slices must default to real arrays, NOT the Proxy's `noop`
  // fallback (a function) — consumers iterate them (`plugins.find`,
  // `appRuns.filter`) and a function would throw "x is not a function".
  appRuns: [],
  plugins: [],
  pluginSaving: new Set<string>(),
  pluginSaveSuccess: new Set<string>(),
  favoriteApps: [],
  recentApps: [],
  pendingRestart: false,
  pendingRestartReasons: [],
  restartBannerDismissed: false,
  systemWarnings: [],
  t: (key, values) => values?.defaultValue?.toString() ?? key,
  triggerRestart: noopAsync,
  uiLanguage: "en",
};

function createMockApp(overrides: MockAppOptions = {}): AppContextValue {
  const value = {
    ...baseMockApp,
    ...overrides,
    agentStatus:
      overrides.agentStatus === null
        ? null
        : {
            ...baseMockApp.agentStatus,
            ...overrides.agentStatus,
          },
  };

  return new Proxy(value, {
    get(target, prop: keyof AppContextValue) {
      if (prop in target) return target[prop];
      return noop;
    },
  }) as AppContextValue;
}

/**
 * Lightweight {@link TranslationCtx} provider for stories — a real `en`
 * translator with no network sync (unlike the production `TranslationProvider`,
 * which calls the API client on mount/change). Components that read
 * `useTranslation()` render cleanly under this.
 */
export function MockTranslationProvider({
  children,
  uiLanguage = "en",
}: {
  children: ReactNode;
  uiLanguage?: UiLanguage;
}) {
  const value: TranslationContextValue = {
    t: createTranslator(uiLanguage),
    uiLanguage,
    setUiLanguage: noop,
  };
  return (
    <TranslationCtx.Provider value={value}>{children}</TranslationCtx.Provider>
  );
}

export function MockAppProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: MockAppOptions;
}) {
  // Provide both the app context and the translation context so components that
  // read either `useApp()` or `useTranslation()` (or both) render in isolation.
  const mockValue = createMockApp(value);
  // This provider supplies a custom AppContext value WITHOUT the real
  // AppProvider, so the useAppSelector external store is never seeded. Publish
  // the same mock value into the store so selector-based consumers resolve.
  publishAppValue(mockValue);
  return (
    <MockTranslationProvider uiLanguage={value?.uiLanguage}>
      <AppContext.Provider value={mockValue}>{children}</AppContext.Provider>
    </MockTranslationProvider>
  );
}
