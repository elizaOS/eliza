import type { ReactNode } from "react";
import { createTranslator, type UiLanguage } from "../i18n";
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
  companionHalfFramerateMode: "when_saving_power",
  dismissBackendDisconnectedBanner: noop,
  dismissSystemWarning: noop,
  navigation: {
    scheduleAfterTabCommit: (fn: () => void) => {
      queueMicrotask(fn);
    },
  },
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
  return (
    <MockTranslationProvider uiLanguage={value?.uiLanguage}>
      <AppContext.Provider value={createMockApp(value)}>
        {children}
      </AppContext.Provider>
    </MockTranslationProvider>
  );
}
