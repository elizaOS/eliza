// @vitest-environment jsdom

/**
 * Verifies that renderer activity collection follows the server-reported
 * Personal Assistant runtime state across loading and hot plugin toggles.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  ensurePluginsLoaded: vi.fn(async () => {}),
  plugins: [] as Array<{
    id: string;
    isActive?: boolean;
    npmName?: string;
  }>,
  pluginsLoaded: false,
}));
const useActivitySignals = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  ElizaClient: function ElizaClient() {},
}));
vi.mock("@elizaos/ui/state", () => ({
  ElizaClient: function ElizaClient() {},
  useAppSelector(selector: (state: typeof appState) => unknown): unknown {
    return selector(appState);
  },
}));
vi.mock("./hooks/useLifeOpsActivitySignals.js", () => ({
  useLifeOpsActivitySignals: useActivitySignals,
}));
vi.mock("./components/AppBlockerSettingsCard.js", () => ({
  AppBlockerSettingsCard: () => null,
}));
vi.mock("./components/WebsiteBlockerSettingsCard.js", () => ({
  WebsiteBlockerSettingsCard: () => null,
}));

import { LifeOpsActivitySignalsEffect } from "./ui.js";

describe("LifeOpsActivitySignalsEffect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.plugins = [];
    appState.pluginsLoaded = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the plugin catalog and keeps collection disabled while status is loading", () => {
    render(<LifeOpsActivitySignalsEffect />);

    expect(appState.ensurePluginsLoaded).toHaveBeenCalledTimes(1);
    expect(useActivitySignals).toHaveBeenLastCalledWith(false);
  });

  it("keeps collection disabled when Personal Assistant is not active", () => {
    appState.pluginsLoaded = true;
    appState.plugins = [
      {
        id: "personal-assistant",
        isActive: false,
        npmName: "@elizaos/plugin-personal-assistant",
      },
    ];

    render(<LifeOpsActivitySignalsEffect />);

    expect(appState.ensurePluginsLoaded).not.toHaveBeenCalled();
    expect(useActivitySignals).toHaveBeenLastCalledWith(false);
  });

  it("enables collection only for the active Personal Assistant runtime", () => {
    appState.pluginsLoaded = true;
    appState.plugins = [
      { id: "unrelated-plugin", isActive: true },
      {
        id: "personal-assistant",
        isActive: true,
        npmName: "@elizaos/plugin-personal-assistant",
      },
    ];

    render(<LifeOpsActivitySignalsEffect />);

    expect(useActivitySignals).toHaveBeenLastCalledWith(true);
  });

  it("tracks Personal Assistant hot disable and re-enable without remounting", () => {
    appState.pluginsLoaded = true;
    appState.plugins = [{ id: "personal-assistant", isActive: true }];
    const view = render(<LifeOpsActivitySignalsEffect />);

    appState.plugins = [{ id: "personal-assistant", isActive: false }];
    view.rerender(<LifeOpsActivitySignalsEffect />);
    appState.plugins = [{ id: "personal-assistant", isActive: true }];
    view.rerender(<LifeOpsActivitySignalsEffect />);

    expect(useActivitySignals.mock.calls.map(([enabled]) => enabled)).toEqual([
      true,
      false,
      true,
    ]);
  });
});
