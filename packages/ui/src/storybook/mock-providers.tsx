import type { Decorator } from "@storybook/react";
import type { ReactNode } from "react";
import { AppContext } from "../state/useApp";
import type { AppContextValue } from "../state/types";

type MockAppOverrides = Partial<AppContextValue>;
type MockAgentStatus = Partial<NonNullable<AppContextValue["agentStatus"]>>;
type MockAppOptions = Omit<MockAppOverrides, "agentStatus"> & {
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

export function MockAppProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: MockAppOptions;
}) {
  return (
    <AppContext.Provider value={createMockApp(value)}>
      {children}
    </AppContext.Provider>
  );
}

export const withMockApp: Decorator = (Story) => (
  <MockAppProvider>
    <Story />
  </MockAppProvider>
);

export function mockApp(overrides?: MockAppOptions): Decorator {
  return (Story) => (
    <MockAppProvider value={overrides}>
      <Story />
    </MockAppProvider>
  );
}
