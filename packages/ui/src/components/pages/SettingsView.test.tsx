// @vitest-environment jsdom

// Renders the real SettingsView against mocked state + stub sections to cover
// the #13590 uniform layout: ONE shared ViewHeader + a folded top-bar section
// nav (no desktop `w-60` rail, no divergent mobile hub, no responsive branch),
// hub → section navigation (section tab → section body → back to hub), the
// initialSection prop, and per-section error boundaries (isolate a throwing
// section, recover on retry). jsdom; sections and state barrel are stubbed.

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
const permissionPrimingMock = vi.hoisted(() => ({
  calls: [] as Array<{ ids: string[]; open: boolean }>,
}));
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

vi.mock("../permissions/PermissionPrimingModal", () => ({
  PermissionPrimingModal: (props: {
    ids: string[];
    open: boolean;
    onComplete: () => void;
  }) => {
    permissionPrimingMock.calls.push({
      ids: props.ids,
      open: props.open,
    });
    return (
      <div
        data-testid="permission-priming-modal"
        data-ids={props.ids.join(",")}
        data-open={String(props.open)}
      />
    );
  },
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
  const groupLabels: Record<string, string> = {
    agent: "Agent",
    system: "System",
    security: "Security",
  };
  const groupOrder = ["agent", "system", "security"];
  return {
    SECTION_TONE_ICON_CLASS: {
      ok: "",
      warn: "",
      muted: "",
      accent: "",
      neutral: "",
    },
    SETTINGS_GROUP_LABEL: groupLabels,
    SETTINGS_GROUP_ORDER: groupOrder,
    SETTINGS_SECTIONS: sections,
    getAllSettingsSections: () => sections,
    // Group the stub sections the way the real helper does (bucket by group,
    // ordered by SETTINGS_GROUP_ORDER) so the folded section-nav renders.
    groupSettingsSections: (input: typeof sections) => {
      const buckets = new Map<string, typeof sections>();
      for (const section of input) {
        const bucket = buckets.get(section.group);
        if (bucket) bucket.push(section);
        else buckets.set(section.group, [section]);
      }
      return [...buckets.entries()]
        .map(([group, items]) => ({
          group,
          label: groupLabels[group] ?? "Other",
          items,
          order: groupOrder.indexOf(group),
        }))
        .sort((a, b) => a.order - b.order)
        .map(({ group, label, items }) => ({ group, label, items }));
    },
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

/** The folded section-nav strip rendered under the shared header. */
function sectionNav(): HTMLElement {
  return screen.getByTestId("settings-section-nav");
}

/** A section tab in the folded nav, by its visible label. */
function sectionTab(label: string): HTMLButtonElement {
  const tab = Array.from(sectionNav().querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
  if (!tab) throw new Error(`no section tab labelled "${label}"`);
  return tab as HTMLButtonElement;
}

beforeEach(() => {
  appMock.value = makeContext();
  permissionPrimingMock.calls = [];
  crashControl.shouldThrow = true;
});

afterEach(() => cleanup());

describe("SettingsView", () => {
  it("calls loadPlugins on mount and renders the uniform header + folded nav", async () => {
    render(<SettingsView />);

    await waitFor(() => {
      expect(appMock.value.loadPlugins).toHaveBeenCalled();
    });
    // The shared ViewHeader renders once, titled "Settings" on the hub.
    const header = screen.getByTestId("view-header");
    expect(header.textContent).toContain("Settings");
    // The folded section nav lists a tab per registered section; no section
    // body is mounted until a tab is selected.
    expect(sectionTab("Basics")).toBeTruthy();
    expect(sectionTab("Runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.queryByTestId("stub-runtime")).toBeNull();
    // The hub rests on its deterministic empty state, not a section body.
    expect(screen.getByTestId("settings-hub-empty")).toBeTruthy();
  });

  it("renders exactly ONE header and NO desktop w-60 rail", () => {
    const { container } = render(<SettingsView />);
    // Uniform top bar: a single shared header, never two stacked.
    expect(screen.getAllByTestId("view-header")).toHaveLength(1);
    // The old persistent desktop rail (`nav.w-60`) is gone in every layout.
    expect(container.querySelector("nav.w-60")).toBeNull();
  });

  it("groups the section tabs by Agent / System under the header", () => {
    render(<SettingsView />);
    const nav = sectionNav();
    expect(nav.textContent).toContain("Agent");
    expect(nav.textContent).toContain("System");
  });

  it("clicking a section tab opens that section under the same header", () => {
    render(<SettingsView />);

    fireEvent.click(sectionTab("Runtime"));

    // The section body is now mounted and the shared header retitles to it.
    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.getByTestId("view-header").textContent).toContain("Runtime");
    // Still exactly one header — the section did not stack a second one.
    expect(screen.getAllByTestId("view-header")).toHaveLength(1);
  });

  it("respects an initialSection prop by opening that section directly", () => {
    render(<SettingsView initialSection="runtime" />);

    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.getByTestId("view-header").textContent).toContain("Runtime");
  });

  it("opens a targeted permission priming modal from a settings navigate payload", async () => {
    render(
      <SettingsView
        initialSection="runtime"
        navigatePayload={{
          permissionRequest: { permission: "microphone" },
        }}
        navigateSequence={1}
      />,
    );

    expect(
      (await screen.findByTestId("permission-priming-modal")).getAttribute(
        "data-ids",
      ),
    ).toBe("microphone");
    expect(permissionPrimingMock.calls.at(-1)).toEqual({
      ids: ["microphone"],
      open: true,
    });
  });

  it("ignores malformed permission request navigation payloads", () => {
    render(
      <SettingsView
        initialSection="runtime"
        navigatePayload={{ permissionRequest: { permission: "shell" } }}
        navigateSequence={1}
      />,
    );

    expect(screen.queryByTestId("permission-priming-modal")).toBeNull();
    expect(permissionPrimingMock.calls).toHaveLength(0);
  });

  it("the header back affordance returns from a section to the hub", () => {
    render(<SettingsView initialSection="runtime" />);

    const back = screen.getByRole("button", { name: "Back to Settings" });
    fireEvent.click(back);

    // Back on the hub: header titled "Settings", empty state, no section body.
    expect(screen.getByTestId("view-header").textContent).toContain("Settings");
    expect(screen.getByTestId("settings-hub-empty")).toBeTruthy();
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
      // per-section fallback renders and the header/nav stay usable.
      expect(screen.getByTestId("settings-section-error")).toBeTruthy();
      expect(screen.queryByTestId("stub-crash")).toBeNull();
      expect(screen.getByTestId("view-header").textContent).toContain("Crash");
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

  // ── #13590: form-factor independence ──────────────────────────────────────
  //
  // The uniform layout has NO responsive branch (the desktop rail + mobile-hub
  // split is gone). The same header + folded nav render regardless of viewport,
  // so a mocked matchMedia must NOT change what is shown.

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

  it("renders the same folded nav + hub on a wide (desktop) viewport", () => {
    const restore = mockMatchMedia(() => true);
    try {
      render(<SettingsView />);
      // No auto-selected pane, no rail — just the hub + folded nav, as on mobile.
      expect(sectionTab("Basics")).toBeTruthy();
      expect(sectionTab("Runtime")).toBeTruthy();
      expect(screen.getByTestId("settings-hub-empty")).toBeTruthy();
      expect(screen.queryByTestId("stub-identity")).toBeNull();
      expect(screen.getAllByTestId("view-header")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("renders the same folded nav + hub on a narrow (mobile) viewport", () => {
    const restore = mockMatchMedia(() => false);
    try {
      render(<SettingsView />);
      expect(sectionTab("Basics")).toBeTruthy();
      expect(screen.getByTestId("settings-hub-empty")).toBeTruthy();
      expect(screen.queryByTestId("stub-identity")).toBeNull();
      expect(screen.getAllByTestId("view-header")).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
