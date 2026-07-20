/**
 * Packaged desktop storage seeding for regression tests that need a returning
 * install profile. The bridge is intentionally narrow: desktop test packaging
 * injects a marker global, and only then does this module expose one helper that
 * writes the exact first-run keys through the shell storage privilege channel.
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

export interface PackagedShellStorageTestBridge {
  seedReturningInstallState(apiBase: string): ReturningInstallSeedResult;
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

function readSeededState(): ReturningInstallSeedResult {
  return {
    ok: true,
    firstRunComplete: shellLocalStorage.getItem("eliza:first-run-complete"),
    setupStep: shellLocalStorage.getItem("eliza:setup:step"),
    uiShellMode: shellLocalStorage.getItem("eliza:ui-shell-mode"),
    activeServer: shellLocalStorage.getItem("elizaos:active-server"),
  };
}

export function seedReturningInstallStateForPackagedTests(
  apiBase: string,
  win = window,
): ReturningInstallSeedResult {
  shellLocalStorage.removeItem("elizaos:first-run:force-fresh");
  shellLocalStorage.setItem("eliza:first-run-complete", "1");
  shellLocalStorage.setItem("eliza:setup:step", "activate");
  shellLocalStorage.setItem("eliza:ui-shell-mode", "native");
  shellLocalStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({
      id: `remote:${apiBase}`,
      kind: "remote",
      label: labelForApiBase(apiBase),
      apiBase,
    }),
  );
  return readSeededState();
}

export function installPackagedShellStorageTestBridge(win = window): boolean {
  if (Reflect.get(win, DESKTOP_TEST_BRIDGE_MARKER) !== true) {
    return false;
  }

  const bridge: PackagedShellStorageTestBridge = {
    seedReturningInstallState: (apiBase) =>
      seedReturningInstallStateForPackagedTests(apiBase, win),
  };
  Object.defineProperty(win, PACKAGED_SHELL_STORAGE_TEST_GLOBAL, {
    configurable: true,
    enumerable: false,
    value: bridge,
    writable: false,
  });
  return true;
}
