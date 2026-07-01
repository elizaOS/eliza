// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import {
  ADVANCED_TOGGLE_STORAGE_KEY,
  advancedToggleListeners,
} from "./AdvancedToggle.hooks";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import type { UiThemeMode } from "../../state/ui-preferences";

// A single, referentially-STABLE translation fn. If this were re-created per
// render the component's useAgentElement effects would loop and the file would
// hang — keep it hoisted/stable.
const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? _key;

interface SeedOverrides {
  uiThemeMode?: UiThemeMode;
  uiLanguage?: string;
  setUiThemeMode?: (mode: UiThemeMode) => void;
  setUiLanguage?: (id: string) => void;
  setState?: (key: string, value: unknown) => void;
  activePackId?: string | null;
}

function seed(overrides: SeedOverrides = {}) {
  const setUiThemeMode = overrides.setUiThemeMode ?? vi.fn();
  const setUiLanguage = overrides.setUiLanguage ?? vi.fn();
  const setState = overrides.setState ?? vi.fn();
  __setAppValueForTests({
    t,
    uiLanguage: overrides.uiLanguage ?? "en",
    setUiLanguage,
    uiThemeMode: overrides.uiThemeMode ?? "system",
    setUiThemeMode,
    backgroundConfig: { mode: "shader", color: "#ef5a1f" },
    setBackgroundConfig: vi.fn(),
    undoBackgroundConfig: vi.fn(),
    canUndoBackground: false,
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
    activePackId: overrides.activePackId ?? null,
    selectedVrmIndex: 0,
    customVrmUrl: "",
    customVrmPreviewUrl: "",
    customBackgroundUrl: "",
    customWorldUrl: "",
    firstRunName: "",
    firstRunStyle: "",
    setState,
  } as never);
  return { setUiThemeMode, setUiLanguage, setState };
}

/** Resolve a theme tile by its visible label ("Light" | "Dark" | "System"). */
function themeTile(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  // AdvancedToggle persists to localStorage + a module-level listener set that
  // survives across tests — reset both so tests stay independent.
  window.localStorage.removeItem(ADVANCED_TOGGLE_STORAGE_KEY);
  advancedToggleListeners.clear();
  vi.clearAllMocks();
});

describe("AppearanceSettingsSection theme selection", () => {
  it("fires setUiThemeMode with the exact selected mode", () => {
    const { setUiThemeMode } = seed({ uiThemeMode: "system" });
    render(<AppearanceSettingsSection />);

    fireEvent.click(themeTile("Dark"));

    expect(setUiThemeMode).toHaveBeenCalledTimes(1);
    expect(setUiThemeMode).toHaveBeenCalledWith("dark");
  });

  it("reflects the persisted theme in the DOM via aria-current (store round-trip)", () => {
    seed({ uiThemeMode: "dark" });
    render(<AppearanceSettingsSection />);

    // Exactly the persisted mode is marked current; the others are not.
    expect(themeTile("Dark").getAttribute("aria-current")).toBe("true");
    expect(themeTile("Light").getAttribute("aria-current")).toBeNull();
    expect(themeTile("System").getAttribute("aria-current")).toBeNull();
  });

  it("moves the active marker when a different mode is persisted", () => {
    seed({ uiThemeMode: "light" });
    render(<AppearanceSettingsSection />);

    expect(themeTile("Light").getAttribute("aria-current")).toBe("true");
    expect(themeTile("Dark").getAttribute("aria-current")).toBeNull();
    // The active tile also advertises its agent status for the overlay.
    expect(themeTile("Light").getAttribute("data-state")).toBe("active");
    expect(themeTile("Dark").getAttribute("data-state")).toBe("inactive");
  });

  it("fires an idempotent setter even when the already-active mode is clicked", () => {
    const { setUiThemeMode } = seed({ uiThemeMode: "dark" });
    render(<AppearanceSettingsSection />);

    fireEvent.click(themeTile("Dark"));

    // Selecting the current mode still dispatches the same value — a no-op
    // downstream, never a crash or a different payload.
    expect(setUiThemeMode).toHaveBeenCalledTimes(1);
    expect(setUiThemeMode).toHaveBeenCalledWith("dark");
  });

  it("dispatches every rapid-fire click with a stable payload (no coalescing)", () => {
    const { setUiThemeMode } = seed({ uiThemeMode: "system" });
    render(<AppearanceSettingsSection />);

    const dark = themeTile("Dark");
    fireEvent.click(dark);
    fireEvent.click(dark);
    fireEvent.click(dark);

    expect(setUiThemeMode).toHaveBeenCalledTimes(3);
    for (const call of setUiThemeMode.mock.calls) {
      expect(call).toEqual(["dark"]);
    }
  });

  it("routes distinct tiles to distinct modes across a rapid sequence", () => {
    const { setUiThemeMode } = seed({ uiThemeMode: "system" });
    render(<AppearanceSettingsSection />);

    fireEvent.click(themeTile("Light"));
    fireEvent.click(themeTile("Dark"));
    fireEvent.click(themeTile("System"));

    expect(setUiThemeMode.mock.calls).toEqual([["light"], ["dark"], ["system"]]);
  });
});

describe("AppearanceSettingsSection language selection", () => {
  it("fires setUiLanguage with the exact language id", () => {
    const { setUiLanguage } = seed({ uiLanguage: "en" });
    render(<AppearanceSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: /한국어/ }));

    expect(setUiLanguage).toHaveBeenCalledTimes(1);
    expect(setUiLanguage).toHaveBeenCalledWith("ko");
  });

  it("marks only the persisted language as current", () => {
    seed({ uiLanguage: "ja" });
    render(<AppearanceSettingsSection />);

    const japanese = screen.getByRole("button", { name: /日本語/ });
    const english = screen.getByRole("button", { name: /English/ });
    expect(japanese.getAttribute("aria-current")).toBe("true");
    expect(english.getAttribute("aria-current")).toBeNull();
  });

  it("keeps theme and language setters independent", () => {
    const { setUiThemeMode, setUiLanguage } = seed({
      uiLanguage: "en",
      uiThemeMode: "system",
    });
    render(<AppearanceSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: /Español/ }));

    expect(setUiLanguage).toHaveBeenCalledWith("es");
    expect(setUiThemeMode).not.toHaveBeenCalled();
  });
});

describe("AppearanceSettingsSection advanced gate + content-pack form", () => {
  it("hides the content-pack loader until the advanced toggle is enabled", () => {
    seed();
    render(<AppearanceSettingsSection />);

    // Default (localStorage unset) → advanced OFF → loader not mounted.
    expect(screen.queryByText("Load content pack")).toBeNull();

    const advancedSwitch = screen.getByRole("switch", { name: "Advanced" });
    expect(advancedSwitch.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(advancedSwitch);

    // Enabling advanced reveals the content-pack loader via the shared flag.
    expect(advancedSwitch.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Load content pack")).toBeTruthy();
  });

  it("never renders background controls in the appearance section, even with advanced on", () => {
    seed();
    render(<AppearanceSettingsSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Advanced" }));

    // Background controls live in the dedicated Background section, not here.
    expect(screen.queryByTestId("background-settings-controls")).toBeNull();
    expect(screen.queryByLabelText("Set background to Green")).toBeNull();
  });
});
