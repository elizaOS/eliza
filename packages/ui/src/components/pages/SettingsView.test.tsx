// @vitest-environment jsdom

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

// SettingsView's own responsibility is section navigation + a loadPlugins
// kickoff on mount — the individual section bodies are heavy, independently
// data-fetching components. To test the view in isolation (its real, non-
// trivial logic) we replace the section registry with lightweight stub
// components. This is deliberate partial coverage: we exercise SettingsView's
// navigation/lifecycle behavior, not each section's internals (which warrant
// their own tests). The useApp + section-registry mocks are the seams the Q2
// refactor must keep stable.
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({ useApp: () => appMock.value }));

vi.mock("../settings/settings-sections", () => ({
  SECTION_TONE_ICON_CLASS: {
    ok: "",
    warn: "",
    muted: "",
    accent: "",
    neutral: "",
  },
  SETTINGS_SECTIONS: [
    {
      id: "identity",
      label: "settings.sections.identity.label",
      defaultLabel: "Basics",
      icon: Settings,
      tone: "neutral",
      titleKey: "settings.sections.identity.label",
      defaultTitle: "Basics",
      Component: () => <div data-testid="stub-identity">Identity body</div>,
    },
    {
      id: "runtime",
      label: "settings.sections.runtime.label",
      defaultLabel: "Runtime",
      icon: Settings,
      tone: "neutral",
      titleKey: "settings.sections.runtime.label",
      defaultTitle: "Runtime",
      Component: () => <div data-testid="stub-runtime">Runtime body</div>,
    },
  ],
  readSettingsHashSection: () => null,
  replaceSettingsHash: vi.fn(),
  settingsSectionLabel: (section: { defaultLabel: string }) =>
    section.defaultLabel,
  settingsSectionTitle: (section: { defaultTitle: string }) =>
    section.defaultTitle,
}));

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
  // jsdom doesn't implement these layout APIs the section-alignment effects use.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo =
    vi.fn() as unknown as typeof Element.prototype.scrollTo;
  appMock.value = makeContext();
});

afterEach(() => cleanup());

describe("SettingsView", () => {
  it("calls loadPlugins on mount and renders the section bodies + nav entries", async () => {
    render(<SettingsView />);

    await waitFor(() => {
      expect(appMock.value.loadPlugins).toHaveBeenCalled();
    });
    // Both registered sections render their bodies.
    expect(screen.getByTestId("stub-identity")).toBeTruthy();
    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    // Both appear as navigation entries (label rendered in the sidebar nav).
    expect(screen.getAllByText("Basics").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Runtime").length).toBeGreaterThan(0);
  });

  it("clicking a sidebar section marks it as the current page", () => {
    render(<SettingsView />);

    const runtimeNav = screen
      .getAllByText("Runtime")
      .map((node) => node.closest("button"))
      .find((btn): btn is HTMLButtonElement => btn !== null);
    expect(runtimeNav).toBeTruthy();

    fireEvent.click(runtimeNav as HTMLButtonElement);

    // The activated nav item is marked aria-current="page".
    expect(runtimeNav?.getAttribute("aria-current")).toBe("page");
  });

  it("respects an initialSection prop by activating that section", () => {
    render(<SettingsView initialSection="runtime" />);

    const runtimeNav = screen
      .getAllByText("Runtime")
      .map((node) => node.closest("button"))
      .find((btn): btn is HTMLButtonElement => btn !== null);

    expect(runtimeNav?.getAttribute("aria-current")).toBe("page");
  });
});
