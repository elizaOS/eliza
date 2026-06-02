import type { Decorator } from "@storybook/react";
import type * as React from "react";
import { AppContext } from "../state/internal";

/**
 * A minimal mock of the AppContext value for Storybook. Components only read the
 * fields they use, so a partial mock (cast to the full type) is enough to render
 * the ~100 components that call useApp() in isolation.
 *
 * Lives under src/ (not .storybook/) so it shares the stories' module graph +
 * react/react-dom dedupe — a decorator imported from the config dir does not,
 * which silently breaks story rendering.
 *
 * i18n `t` returns the provided defaultValue (or the key); setters are no-ops;
 * common state has sensible defaults. Use {@link mockApp} to override fields for
 * a specific story (e.g. force a conditional banner/overlay into its visible
 * state). {@link withMockApp} is the no-override decorator for the common case.
 */
type AppValue = React.ContextType<typeof AppContext>;

const BASE: Record<string, unknown> = {
  t: (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
  tab: "chat",
  setTab: () => {},
  setState: () => {},
  setActionNotice: () => {},
  copyToClipboard: () => {},
  plugins: [],
  uiTheme: "dark",
  setUiTheme: () => {},
  uiLanguage: "en",
  setUiLanguage: () => {},
  appRuns: [],
  activeOverlayApp: null,
  activeGameRunId: "",
  ownerName: "",
  loadDropStatus: () => {},
  browserEnabled: false,
  walletEnabled: false,
};

/** Decorator factory: render the story under a mock AppContext, with optional
 *  field overrides (e.g. `mockApp({ commandPaletteOpen: true })`). */
export function mockApp(overrides: Record<string, unknown> = {}): Decorator {
  const value = { ...BASE, ...overrides } as unknown as AppValue;
  return (Story) => (
    <AppContext.Provider value={value}>
      <Story />
    </AppContext.Provider>
  );
}

/** The common-case decorator: a mock AppContext with default values. */
export const withMockApp: Decorator = mockApp();
