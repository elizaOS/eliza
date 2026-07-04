// @vitest-environment jsdom

// Renders the real SettingsView against mocked state + stub sections to cover
// hub navigation (tile → full-width section → back), the initialSection prop,
// per-section error boundaries (isolate a throwing section, recover on retry),
// and the responsive layout switch (single-column hub vs two-pane rail by
// width/orientation). jsdom; sections and state barrel are stubbed.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

// SettingsView's own responsibility is hub → section navigation + a loadPlugins
// kickoff on mount — the individual section bodies are heavy, independently
// data-fetching components. To test the view in isolation (its real, non-
// trivial logic) we replace the section registry with lightweight stub
// components. This is deliberate partial coverage: we exercise SettingsView's
// navigation/lifecycle behavior, not each section's internals (which warrant
// their own tests). The useApp + section-registry mocks are the seams this
// refactor must keep stable.
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
// Controls whether the deliberately-throwing "crash" section throws on render,
// so a single test can flip it off and assert the per-section retry recovers.
const crashControl = vi.hoisted(() => ({ shouldThrow: true }));
const stubSections = vi.hoisted(() => [
  {
    id: "identity",
    label: "settings.sections.identity.label",
    defaultLabel: "Basics",
    tone: "neutral",
    hue: "slate",
    group: "agent",
    titleKey: "settings.sections.identity.label",
    defaultTitle: "Basics",
  },
  {
    id: "runtime",
    label: "settings.sections.runtime.label",
    defaultLabel: "Runtime",
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.runtime.label",
    defaultTitle: "Runtime",
  },
  {
    id: "crash",
    label: "settings.sections.crash.label",
    defaultLabel: "Crash",
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.crash.label",
    defaultTitle: "Crash",
  },
]);

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../settings/settings-sections", () => {
  const sections = stubSections.map((section) => ({
    ...section,
    icon: Settings,
    Component:
      section.id === "crash"
        ? () => {
            if (crashControl.shouldThrow) {
              throw new Error("crash section blew up on mount");
            }
            return (
              <div data-testid="stub-crash">{section.defaultLabel} body</div>
            );
          }
        : () => (
            <div data-testid={`stub-${section.id}`}>
              {section.defaultLabel} body
            </div>
          ),
  }));
  return {
    SECTION_TONE_ICON_CLASS: {
      ok: "",
      warn: "",
      muted: "",
      accent: "",
      neutral: "",
    },
    SETTINGS_GROUP_LABEL: {
      agent: "Agent",
      system: "System",
      security: "Security",
    },
    SETTINGS_GROUP_ORDER: ["agent", "system", "security"],
    SETTINGS_SECTIONS: sections,
    getAllSettingsSections: () => sections,
    readSettingsHashSection: () => null,
    replaceSettingsHash: vi.fn(),
    settingsSectionLabel: (section: { defaultLabel: string }) =>
      section.defaultLabel,
    settingsSectionTitle: (section: { defaultTitle: string }) =>
      section.defaultTitle,
  };
});

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    t,
    loadPlugins: vi.fn(async () => {}),
    walletEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  appMock.value = makeContext();
  crashControl.shouldThrow = true;
});

afterEach(() => cleanup());

describe("SettingsView", () => {
  it("calls loadPlugins on mount and renders the hub tiles", async () => {
    render(<SettingsView />);

    await waitFor(() => {
      expect(appMock.value.loadPlugins).toHaveBeenCalled();
    });
    // The hub shows a tile per registered section; no section body is mounted
    // until a tile is selected.
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.queryByTestId("stub-runtime")).toBeNull();
  });

  it("clicking a hub tile opens that section full-width", () => {
    render(<SettingsView />);

    const runtimeTile = screen
      .getByText("Runtime")
      .closest("button") as HTMLButtonElement;
    expect(runtimeTile).toBeTruthy();

    fireEvent.click(runtimeTile);

    // The section body is now mounted, and a back affordance is present.
    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("respects an initialSection prop by opening that section directly", () => {
    render(<SettingsView initialSection="runtime" />);

    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
  });

  it("back affordance returns to the hub", () => {
    render(<SettingsView initialSection="runtime" />);

    const back = screen.getByText("Settings").closest("button");
    expect(back).toBeTruthy();
    fireEvent.click(back as HTMLButtonElement);

    // Both tiles are visible again and no section body is mounted.
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.queryByTestId("stub-runtime")).toBeNull();
  });

  it("isolates a throwing section behind a per-section error boundary", () => {
    // React logs the caught render error to console.error; silence it so the
    // test output stays clean while still exercising the boundary.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(<SettingsView initialSection="crash" />);

      // The section body crashed, but the shell did NOT blank: the inline
      // per-section fallback renders and the nav back-affordance stays usable.
      expect(screen.getByTestId("settings-section-error")).toBeTruthy();
      expect(screen.queryByTestId("stub-crash")).toBeNull();
      expect(screen.getByText("Settings")).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("recovers the section when retry is pressed after the cause is fixed", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(<SettingsView initialSection="crash" />);
      expect(screen.getByTestId("settings-section-error")).toBeTruthy();

      // The underlying cause is resolved, then the user hits Retry.
      crashControl.shouldThrow = false;
      fireEvent.click(screen.getByText("Retry"));

      // The boundary resets and the real section body now renders.
      expect(screen.getByTestId("stub-crash")).toBeTruthy();
      expect(screen.queryByTestId("settings-section-error")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("on desktop, shows a persistent rail with a section selected in the pane", () => {
    // Force the desktop media query to match so the two-pane layout renders.
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      render(<SettingsView />);
      // The rail lists every section AND the detail pane shows the first one
      // (no tap + no back button needed on desktop). "Basics" appears twice on
      // desktop: the rail item and the detail-pane title.
      expect(screen.getAllByText("Basics").length).toBeGreaterThan(0);
      expect(screen.getByText("Runtime")).toBeTruthy();
      expect(screen.getByTestId("stub-identity")).toBeTruthy();
      expect(screen.queryByText("Settings")).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  // ── #9945: orientation-aware two-pane selection ───────────────────────────

  /** Mock matchMedia so each query resolves by the supplied predicate. */
  function mockMatchMedia(matches: (query: string) => boolean) {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }

  it("uses the two-pane layout for a landscape phone (narrow width, landscape)", () => {
    // Landscape phone: NOT min-width:1024, but it IS min-width:768 + landscape.
    // A plain width-only check would wrongly drop it into the hub.
    const restore = mockMatchMedia(
      (query) => query === "(min-width: 768px) and (orientation: landscape)",
    );
    try {
      render(<SettingsView />);
      // Two-pane auto-selects the first section's body (no tap needed).
      expect(screen.getByTestId("stub-identity")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("uses the single-column hub for a portrait tablet (narrow width, portrait)", () => {
    // Portrait tablet: neither min-width:1024 nor the landscape combo matches.
    const restore = mockMatchMedia(() => false);
    try {
      render(<SettingsView />);
      // Hub shows the nav rows but does not auto-render a section body.
      expect(screen.queryByTestId("stub-identity")).toBeNull();
      expect(screen.getByText("Basics")).toBeTruthy();
    } finally {
      restore();
    }
  });
});
