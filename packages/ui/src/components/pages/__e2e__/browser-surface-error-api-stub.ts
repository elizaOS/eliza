/**
 * Fixture stand-in for the `src/api` barrel used by
 * run-browser-surface-error-e2e.mjs. Supplies one open example.com tab so the
 * native error card has a selected tab for its Open-external escape hatch;
 * everything else rejects like an absent backend. Types are structural — the
 * fixture bundle never loads the real client.
 */

const TAB = {
  id: "tab-1",
  title: "Example",
  url: "https://example.com/",
  partition: "persist:fixture",
  visible: true,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  lastFocusedAt: null,
};

const reject = () => Promise.reject(new Error("no api in fixture"));

export const client: Record<string, unknown> = {
  getBrowserWorkspace: async () => ({ mode: "web", tabs: [TAB] }),
  fetch: reject,
  getWalletConfig: reject,
  getAutofillAllowed: reject,
  listSavedLogins: reject,
  revealSavedLogin: reject,
  openBrowserWorkspaceTab: reject,
  navigateBrowserWorkspaceTab: reject,
  closeBrowserWorkspaceTab: reject,
  showBrowserWorkspaceTab: reject,
  snapshotBrowserWorkspaceTab: reject,
  sendBrowserSolanaTransaction: reject,
  sendBrowserWalletTransaction: reject,
  signBrowserSolanaMessage: reject,
  signBrowserWalletMessage: reject,
};

/** Supplies constructor imports while preserving the fixture's shared client. */
export function ElizaClient() {
  return client;
}
