import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  registerAppShellPage,
  subscribeAppShellPages,
} from "./app-shell-registry";
import { resetUiRegistryHostForTests } from "./registry-host";

describe("app-shell-registry", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

  it("stores metadata-only lazy registrations and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppShellPages(listener);
    const before = getAppShellPageRegistrySnapshot();
    const id = `test.lazy-page.${before}`;

    registerAppShellPage({
      id,
      pluginId: "test-plugin",
      label: "Lazy test page",
      path: `/test-lazy-page-${before}`,
      backgroundPolicy: "shared",
      loader: async () => ({ default: () => null }),
    });

    expect(getAppShellPageRegistrySnapshot()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    const registration = listAppShellPages().find((entry) => entry.id === id);
    expect(registration).toEqual(
      expect.objectContaining({
        backgroundPolicy: "shared",
        id,
        loader: expect.any(Function),
      }),
    );
    expect(registration?.Component).toBeUndefined();

    unsubscribe();
    registerAppShellPage({
      id: `${id}.after-unsubscribe`,
      pluginId: "test-plugin",
      label: "Lazy test page after unsubscribe",
      path: `/test-lazy-page-${before}-after-unsubscribe`,
      loader: async () => ({ default: () => null }),
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
