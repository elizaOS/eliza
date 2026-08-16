/**
 * Installs the native desktop-shell contract required by browser fixtures that
 * expose an Electrobun RPC marker. The accessor preserves these boot-critical
 * methods when a fixture layers its own status, permissions, or event bridge.
 */

import type { Page } from "@playwright/test";

export async function installReadyDesktopShellBridge(
  page: Page,
): Promise<void> {
  await page.addInitScript(() => {
    type Bridge = {
      request?: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
      offMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
    };

    const win = window as Window & { __ELIZA_ELECTROBUN_RPC__?: Bridge };
    const withDesktopShell = (bridge?: Bridge, previous?: Bridge): Bridge => ({
      ...previous,
      ...bridge,
      request: {
        desktopGetVersion: async () => ({ runtime: "playwright-smoke" }),
        desktopRegisterShortcut: async () => ({ success: true }),
        desktopSetTrayMenu: async () => undefined,
        ...(previous?.request ?? {}),
        ...(bridge?.request ?? {}),
      },
      onMessage: bridge?.onMessage ?? previous?.onMessage ?? (() => {}),
      offMessage: bridge?.offMessage ?? previous?.offMessage ?? (() => {}),
    });

    let currentBridge = withDesktopShell(win.__ELIZA_ELECTROBUN_RPC__);
    Object.defineProperty(win, "__ELIZA_ELECTROBUN_RPC__", {
      configurable: true,
      get() {
        return currentBridge;
      },
      set(nextBridge: Bridge | undefined) {
        currentBridge = withDesktopShell(nextBridge, currentBridge);
      },
    });
  });
}
