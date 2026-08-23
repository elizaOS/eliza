/**
 * Packaged shell storage test bridge coverage proves returning-install seeding
 * stays behind the desktop test marker and writes through the shell privilege
 * facade instead of raw surface localStorage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storageBridge = vi.hoisted(() => ({
  getItem: vi.fn((key: string) => window.localStorage.getItem(key)),
  setItem: vi.fn((key: string, value: string) =>
    window.localStorage.setItem(key, value),
  ),
  removeItem: vi.fn((key: string) => window.localStorage.removeItem(key)),
  removeStorageValue: vi.fn(async (key: string) =>
    window.localStorage.removeItem(key),
  ),
  getStorageValue: vi.fn(async (key: string) =>
    window.localStorage.getItem(key),
  ),
  setStorageValue: vi.fn(async (key: string, value: string) =>
    window.localStorage.setItem(key, value),
  ),
}));

vi.mock("@elizaos/ui/bridge", () => ({
  getStorageValue: storageBridge.getStorageValue,
  removeStorageValue: storageBridge.removeStorageValue,
  setStorageValue: storageBridge.setStorageValue,
  shellLocalStorage: storageBridge,
}));

import {
  installPackagedShellStorageTestBridge,
  readReturningInstallStateForPackagedTests,
  seedResettableStateForPackagedTests,
  seedReturningInstallStateForPackagedTests,
} from "./packaged-shell-storage-test-bridge";

describe("packaged shell storage test bridge", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(window, "__ELIZA_DESKTOP_TEST_BRIDGE_ENABLED__");
    Reflect.deleteProperty(window, "__ELIZA_PACKAGED_SHELL_STORAGE_TEST__");
    storageBridge.setItem.mockClear();
    storageBridge.removeItem.mockClear();
    storageBridge.removeStorageValue.mockClear();
    storageBridge.getItem.mockClear();
    storageBridge.getStorageValue.mockClear();
    storageBridge.setStorageValue.mockClear();
  });

  it("does not expose the seed helper without the packaged desktop test marker", () => {
    expect(installPackagedShellStorageTestBridge()).toBe(false);

    expect(window.__ELIZA_PACKAGED_SHELL_STORAGE_TEST__).toBeUndefined();
  });

  it("exposes only the packaged storage seed helpers when the marker is present", () => {
    window.__ELIZA_DESKTOP_TEST_BRIDGE_ENABLED__ = true;

    expect(installPackagedShellStorageTestBridge()).toBe(true);

    expect(
      Object.keys(window.__ELIZA_PACKAGED_SHELL_STORAGE_TEST__ ?? {}),
    ).toEqual([
      "clearProtectedTestState",
      "readReturningInstallState",
      "seedResettableState",
      "seedReturningInstallState",
    ]);
  });

  it("clears protected test state through the secure storage bridge", async () => {
    window.__ELIZA_DESKTOP_TEST_BRIDGE_ENABLED__ = true;
    installPackagedShellStorageTestBridge();

    await window.__ELIZA_PACKAGED_SHELL_STORAGE_TEST__?.clearProtectedTestState();

    expect(storageBridge.removeStorageValue).toHaveBeenCalledWith(
      "elizaos:active-server",
    );
  });

  it("awaits protected storage when seeding resettable local state", async () => {
    const result = await seedResettableStateForPackagedTests();

    expect(storageBridge.setItem).toHaveBeenCalledWith(
      "eliza:first-run-complete",
      "1",
    );
    expect(storageBridge.setStorageValue).toHaveBeenCalledWith(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    );
    expect(result).toEqual({
      ok: true,
      firstRunComplete: "1",
      activeServer: JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    });
  });

  it("awaits protected storage when seeding returning-install state", async () => {
    const result = await seedReturningInstallStateForPackagedTests(
      "http://127.0.0.1:31337",
      "Alt+Shift+Super+F11",
    );

    expect(storageBridge.removeItem).toHaveBeenCalledWith(
      "elizaos:first-run:force-fresh",
    );
    expect(storageBridge.setItem).toHaveBeenCalledWith(
      "eliza:first-run-complete",
      "1",
    );
    expect(storageBridge.setItem).toHaveBeenCalledWith(
      "eliza:setup:step",
      "activate",
    );
    expect(storageBridge.setItem).toHaveBeenCalledWith(
      "eliza:ui-shell-mode",
      "native",
    );
    expect(storageBridge.setItem).toHaveBeenCalledWith(
      "eliza:chatOverlayHotkey",
      JSON.stringify({
        accelerator: "Alt+Shift+Super+F11",
        enabled: true,
      }),
    );
    expect(storageBridge.setStorageValue).toHaveBeenCalledWith(
      "elizaos:active-server",
      expect.stringContaining('"kind":"remote"'),
    );
    expect(result).toMatchObject({
      ok: true,
      firstRunComplete: "1",
      setupStep: "activate",
      uiShellMode: "native",
    });
    expect(JSON.parse(result.activeServer ?? "{}")).toEqual({
      id: "remote:http://127.0.0.1:31337",
      kind: "remote",
      label: "127.0.0.1:31337",
      apiBase: "http://127.0.0.1:31337",
    });
  });

  it("reads active-server through protected storage", async () => {
    window.localStorage.setItem("eliza:first-run-complete", "1");
    window.localStorage.setItem("eliza:setup:step", "activate");
    window.localStorage.setItem("eliza:ui-shell-mode", "native");
    window.localStorage.setItem("elizaos:active-server", "protected-value");

    const result = await readReturningInstallStateForPackagedTests();

    expect(storageBridge.getStorageValue).toHaveBeenCalledWith(
      "elizaos:active-server",
    );
    expect(result).toEqual({
      ok: true,
      firstRunComplete: "1",
      setupStep: "activate",
      uiShellMode: "native",
      activeServer: "protected-value",
    });
  });
});
