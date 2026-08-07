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
}));

vi.mock("@elizaos/ui/bridge", () => ({
  shellLocalStorage: storageBridge,
}));

import {
  installPackagedShellStorageTestBridge,
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
    storageBridge.getItem.mockClear();
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
    ).toEqual(["seedResettableState", "seedReturningInstallState"]);
  });

  it("seeds resettable local state through shellLocalStorage", () => {
    const result = seedResettableStateForPackagedTests();

    expect(storageBridge.setItem).toHaveBeenCalledWith(
      "eliza:first-run-complete",
      "1",
    );
    expect(storageBridge.setItem).toHaveBeenCalledWith(
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

  it("seeds returning-install state through shellLocalStorage", () => {
    const result = seedReturningInstallStateForPackagedTests(
      "http://127.0.0.1:31337",
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
});
