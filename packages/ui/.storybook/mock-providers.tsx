import type { Decorator } from "@storybook/react";
import type * as React from "react";
import { AppContext } from "../src/state/internal";

/**
 * A minimal mock of the AppContext value for Storybook. Components only read the
 * fields they use, so a partial mock (cast to the full type) is enough to render
 * the ~100 components that call useApp() in isolation. Extend `MOCK_APP` as more
 * stories need more fields.
 *
 * i18n `t` returns the provided defaultValue (or the key), matching how the real
 * provider degrades; setters are no-ops; common state has sensible defaults.
 */
const MOCK_APP = {
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
} as unknown as React.ContextType<typeof AppContext>;

/** Wraps a story in a mock AppContext so useApp()-dependent components render. */
export const withMockApp: Decorator = (Story) => (
  <AppContext.Provider value={MOCK_APP}>
    <Story />
  </AppContext.Provider>
);
