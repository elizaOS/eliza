/** Verifies RuntimeSettingsSection IA through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * RuntimeSettingsSection is now a status/entry-point surface. Devices & Runtimes owns
 * saved local/cloud/remote switching and remote host add, so this section must
 * not keep its own duplicate remote-connect form or coarse switcher.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isStoreBuild: vi.fn(() => false),
  isElectrobunRuntime: vi.fn(() => false),
  loadPersistedActiveServer: vi.fn(),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: undefined, agentProps: {} }),
}));

vi.mock("../../bridge/electrobun-rpc", () => ({
  inspectExistingElizaInstall: vi.fn(),
  migrateDesktopStateDir: vi.fn(),
  pickDesktopWorkspaceFolder: vi.fn(),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: mocks.isElectrobunRuntime,
}));

vi.mock("../../build-variant", () => ({
  isStoreBuild: mocks.isStoreBuild,
}));

vi.mock("../../hooks/useRuntimeMode", () => ({
  useRuntimeMode: () => ({
    state: { phase: "unavailable" },
    mode: null,
    isLocalOnly: false,
    isCloudMode: false,
    isRemoteMode: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (
        key: string,
        options?: { defaultValue?: string; mode?: string },
      ) => string;
    }) => unknown,
  ) =>
    selector({
      t: (key, options) => {
        const value = options?.defaultValue ?? key;
        return options?.mode ? value.replace("{{mode}}", options.mode) : value;
      },
    }),
}));

vi.mock("../../state/persistence", () => ({
  loadPersistedActiveServer: mocks.loadPersistedActiveServer,
}));

import { RuntimeSettingsSection } from "./RuntimeSettingsSection";

describe("RuntimeSettingsSection IA", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#runtime");
    mocks.isStoreBuild.mockReturnValue(false);
    mocks.isElectrobunRuntime.mockReturnValue(false);
    mocks.loadPersistedActiveServer.mockReset();
    mocks.loadPersistedActiveServer.mockReturnValue({
      id: "cloud:agent-1",
      label: "Trading bot",
      kind: "cloud",
      apiBase: "https://x.agent.elizacloud.ai",
    });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "#");
  });

  it("shows current runtime status and a Devices & Runtimes entry point", () => {
    render(<RuntimeSettingsSection />);

    expect(screen.getByText("Current mode: Trading bot")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Devices & Runtimes/ }),
    ).toBeTruthy();
  });

  it("opens the canonical Devices & Runtimes section through settings hash navigation", () => {
    const onHashChange = vi.fn();
    window.addEventListener("hashchange", onHashChange);
    try {
      render(<RuntimeSettingsSection />);

      fireEvent.click(
        screen.getByRole("button", { name: /Devices & Runtimes/ }),
      );

      expect(window.location.hash).toBe("#my-runtimes");
      expect(onHashChange).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("hashchange", onHashChange);
    }
  });

  it("does not expose the old standalone remote-connect controls", () => {
    render(<RuntimeSettingsSection />);

    expect(screen.queryByRole("button", { name: "Remote" })).toBeNull();
    expect(screen.queryByTestId("settings-remote-address")).toBeNull();
    expect(screen.queryByTestId("settings-remote-connect")).toBeNull();
  });
});
