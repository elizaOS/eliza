/**
 * Packaged desktop storage seeding for regression tests that need a returning
 * install profile. The bridge is intentionally narrow: desktop test packaging
 * injects a marker global, and only then does this module expose narrow helpers
 * that write exact first-run keys through the shell storage privilege channel.
 */
import { shellLocalStorage } from "@elizaos/ui/bridge";

const DESKTOP_TEST_BRIDGE_MARKER = "__ELIZA_DESKTOP_TEST_BRIDGE_ENABLED__";
const PACKAGED_SHELL_STORAGE_TEST_GLOBAL =
  "__ELIZA_PACKAGED_SHELL_STORAGE_TEST__";

export interface ReturningInstallSeedResult {
  ok: true;
  firstRunComplete: string | null;
  setupStep: string | null;
  uiShellMode: string | null;
  activeServer: string | null;
}

export interface ResettableStateSeedResult {
  ok: true;
  firstRunComplete: string | null;
  activeServer: string | null;
}

export interface PackagedShellStorageTestBridge {
  seedResettableState(): ResettableStateSeedResult;
  seedReturningInstallState(
    apiBase: string,
    chatOverlayHotkey?: string,
  ): ReturningInstallSeedResult;
}

declare global {
  interface Window {
    __ELIZA_DESKTOP_TEST_BRIDGE_ENABLED__?: boolean;
    __ELIZA_PACKAGED_SHELL_STORAGE_TEST__?: PackagedShellStorageTestBridge;
  }
}

function labelForApiBase(apiBase: string): string {
  try {
    return new URL(apiBase).host || apiBase;
  } catch {
    return apiBase;
  }
}

function readSeededState(win: Window): ReturningInstallSeedResult {
  // `shellLocalStorage` is a write-only privilege channel (no `getItem`); reads
  // are unguarded, so read the seeded keys back off the global directly.
  return {
    ok: true,
    firstRunComplete: win.localStorage.getItem("eliza:first-run-complete"),
    setupStep: win.localStorage.getItem("eliza:setup:step"),
    uiShellMode: win.localStorage.getItem("eliza:ui-shell-mode"),
    activeServer: win.localStorage.getItem("elizaos:active-server"),
  };
}

export function seedReturningInstallStateForPackagedTests(
  apiBase: string,
  chatOverlayHotkey?: string,
  win = window,
): ReturningInstallSeedResult {
  shellLocalStorage.removeItem("elizaos:first-run:force-fresh");
  shellLocalStorage.setItem("eliza:first-run-complete", "1");
  shellLocalStorage.setItem("eliza:setup:step", "activate");
  shellLocalStorage.setItem("eliza:ui-shell-mode", "native");
  if (chatOverlayHotkey) {
    shellLocalStorage.setItem(
      "eliza:chatOverlayHotkey",
      JSON.stringify({ accelerator: chatOverlayHotkey, enabled: true }),
    );
  }
  shellLocalStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      id: `remote:${apiBase}`,
      kind: "remote",
      label: labelForApiBase(apiBase),
      apiBase,
    }),
  );
  return readSeededState(win);
}

export function seedResettableStateForPackagedTests(
  win = window,
): ResettableStateSeedResult {
  shellLocalStorage.setItem("eliza:first-run-complete", "1");
  shellLocalStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      id: "local:embedded",
      kind: "local",
      label: "This device",
    }),
  );
  return {
    ok: true,
    firstRunComplete: win.localStorage.getItem("eliza:first-run-complete"),
    activeServer: win.localStorage.getItem("elizaos:active-server"),
  };
}

export function installPackagedShellStorageTestBridge(win = window): boolean {
  if (Reflect.get(win, DESKTOP_TEST_BRIDGE_MARKER) !== true) {
    return false;
  }

  const bridge: PackagedShellStorageTestBridge = {
    seedResettableState: () => seedResettableStateForPackagedTests(win),
    seedReturningInstallState: (apiBase, chatOverlayHotkey) =>
      seedReturningInstallStateForPackagedTests(
        apiBase,
        chatOverlayHotkey,
        win,
      ),
  };
  Object.defineProperty(win, PACKAGED_SHELL_STORAGE_TEST_GLOBAL, {
    configurable: true,
    enumerable: false,
    value: bridge,
    writable: false,
  });
  return true;
}
