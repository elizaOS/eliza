/** Verifies SettingsView through the package's configured test harness. */
// @vitest-environment jsdom

// Renders the real SettingsView against mocked state + stub sections to cover
// the mobile hub → subview flow, the persistent desktop workspace, breakpoint
// switching, initialSection, and per-section error boundaries. jsdom; sections
// and state barrel are stubbed.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backFromConnectorDetail,
  openConnectorsIndexHash,
  parseSettingsHash,
  readSettingsHashRoute,
  replaceConnectorDetailHash,
} from "../settings/settings-route";
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
const bootConfigMock = vi.hoisted(() => ({ cloudOnly: false }));
const electrobunRuntimeMock = vi.hoisted(() => ({ isElectrobun: false }));
const androidCloudBuildMock = vi.hoisted(() => ({ isAndroidCloud: false }));
const frontendPlatformMock = vi.hoisted(() => ({ platform: "web" }));
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
    id: "desktop-only",
    label: "settings.sections.desktopOnly.label",
    defaultLabel: "Desktop app",
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: "settings.sections.desktopOnly.label",
    defaultTitle: "Desktop app",
    requires: ["desktop-bridge"],
  },
  {
    id: "managed-hidden",
    label: "settings.sections.managedHidden.label",
    defaultLabel: "Managed implementation control",
    tone: "neutral",
    hue: "slate",
    group: "agent",
    titleKey: "settings.sections.managedHidden.label",
    defaultTitle: "Managed implementation control",
    hideOnManagedCloud: true,
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
  {
    id: "cloud-management",
    label: "settings.sections.cloudManagement.label",
    defaultLabel: "Cloud Management",
    tone: "accent",
    hue: "accent",
    group: "cloud",
    titleKey: "settings.sections.cloudManagement.label",
    defaultTitle: "Cloud Management",
    cloudOnly: true,
  },
  {
    id: "android-account-lifecycle",
    label: "settings.sections.androidAccountLifecycle.label",
    defaultLabel: "Account & Privacy",
    tone: "warn",
    hue: "amber",
    group: "security",
    titleKey: "settings.sections.androidAccountLifecycle.title",
    defaultTitle: "Account & Privacy",
    androidCloudOnly: true,
  },
]);

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../config/boot-config-store", () => ({
  getBootConfig: () => ({ branding: { cloudOnly: bootConfigMock.cloudOnly } }),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => electrobunRuntimeMock.isElectrobun,
}));

vi.mock("../../platform/android-runtime", () => ({
  isAndroidCloudBuild: () => androidCloudBuildMock.isAndroidCloud,
}));

vi.mock("../../platform/platform-guards", async () => {
  const actual = await vi.importActual<
    typeof import("../../platform/platform-guards")
  >("../../platform/platform-guards");
  return {
    ...actual,
    getFrontendPlatform: () => frontendPlatformMock.platform,
  };
});
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
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

vi.mock("../settings/settings-sections", async () => {
  // The pure hash-route helpers are real (they live in settings-route.ts and
  // are re-exported by settings-sections); only the section registry is stubbed.
  const settingsRoute = await vi.importActual<
    typeof import("../settings/settings-route")
  >("../settings/settings-route");
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
    cloud: "Cloud",
  };
  const groupOrder = ["agent", "system", "security"];
  return {
    ...settingsRoute,
    SECTION_TONE_ICON_CLASS: {
      ok: "",
      warn: "",
      muted: "",
      accent: "",
      neutral: "",
    },
    SECTION_HUE_MEDALLION_CLASS: {
      accent: "",
      amber: "",
      rose: "",
      slate: "",
    },
    SETTINGS_GROUP_LABEL: groupLabels,
    SETTINGS_GROUP_ORDER: groupOrder,
    SETTINGS_SECTIONS: sections,
    backFromConnectorDetail,
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
    openConnectorsIndexHash,
    parseSettingsHash,
    readSettingsHashRoute,
    readSettingsHashSection: () => {
      const route = readSettingsHashRoute();
      return route.kind === "hub" ? null : route.sectionId;
    },
    replaceConnectorDetailHash,
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
    startupCoordinator: { target: "embedded-local" },
    ...overrides,
  };
}

/** The grouped hub row list (the settings main screen). */
function hubList(): HTMLElement {
  return screen.getByTestId("settings-hub-list");
}

/** A hub row by its section id. */
function hubRow(id: string): HTMLButtonElement {
  return screen.getByTestId(`settings-hub-row-${id}`) as HTMLButtonElement;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
  appMock.value = makeContext();
  bootConfigMock.cloudOnly = false;
  electrobunRuntimeMock.isElectrobun = false;
  androidCloudBuildMock.isAndroidCloud = false;
  frontendPlatformMock.platform = "web";
  permissionPrimingMock.calls = [];
  crashControl.shouldThrow = true;
});

afterEach(() => cleanup());

describe("SettingsView", () => {
  it("calls loadPlugins on mount and renders the uniform header + hub list", async () => {
    render(<SettingsView />);

    await waitFor(() => {
      expect(appMock.value.loadPlugins).toHaveBeenCalled();
    });
    // The shared ViewHeader renders once, titled "Settings" on the hub.
    const header = screen.getByTestId("view-header");
    expect(header.textContent).toContain("Settings");
    // Product areas stay compact until opened; no section body is mounted until
    // a destination row is tapped.
    expect(hubRow("identity").textContent).toContain("Basics");
    expect(hubRow("runtime").textContent).toContain("Runtime");
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.queryByTestId("stub-runtime")).toBeNull();
  });

  it("renders exactly one header in the mobile hub", () => {
    render(<SettingsView />);
    expect(screen.getAllByTestId("view-header")).toHaveLength(1);
    expect(screen.queryByTestId("desktop-settings-navigation")).toBeNull();
  });

  it("groups the hub rows by Agent / System under the header", () => {
    render(<SettingsView />);
    const nav = hubList();
    expect(nav.textContent).toContain("Agent");
    expect(nav.textContent).toContain("System");
  });

  it("hides Cloud management for local and VPS runtime targets", () => {
    render(<SettingsView />);
    expect(screen.queryByTestId("settings-hub-group-cloud")).toBeNull();

    cleanup();
    appMock.value = makeContext({
      startupCoordinator: { target: "remote-backend" },
    });
    render(<SettingsView />);
    expect(screen.queryByTestId("settings-hub-group-cloud")).toBeNull();
  });

  it("shows Cloud management for a managed Cloud runtime target", () => {
    appMock.value = makeContext({
      startupCoordinator: { target: "cloud-managed" },
    });
    render(<SettingsView />);
    expect(hubRow("cloud-management").textContent).toContain(
      "Cloud Management",
    );
    expect(screen.queryByTestId("settings-hub-row-managed-hidden")).toBeNull();
    expect(screen.queryByTestId("cloud-settings-panel")).toBeNull();
  });

  it("keeps cloud-only Electrobun on the same registry-driven Settings controller", () => {
    bootConfigMock.cloudOnly = true;
    electrobunRuntimeMock.isElectrobun = true;

    render(<SettingsView />);

    expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
    expect(hubRow("desktop-only")).toBeTruthy();
    expect(hubRow("cloud-management")).toBeTruthy();
  });

  it("keeps cloud-only web runtimes on the same controller without desktop modules", () => {
    bootConfigMock.cloudOnly = true;
    electrobunRuntimeMock.isElectrobun = false;

    render(<SettingsView />);

    expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
    expect(screen.queryByTestId("settings-hub-row-desktop-only")).toBeNull();
  });

  it("uses the same controller for modal settings in a cloud-only build", () => {
    bootConfigMock.cloudOnly = true;
    electrobunRuntimeMock.isElectrobun = true;

    render(<SettingsView inModal />);

    expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
  });

  it("resolves an unavailable desktop deep link back to the portable hub", () => {
    render(<SettingsView initialSection="desktop-only" />);

    expect(screen.queryByTestId("stub-desktop-only")).toBeNull();
    expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
    expect(screen.queryByTestId("settings-hub-row-desktop-only")).toBeNull();
  });

  it("canonicalizes an unavailable desktop hash deep link to the portable hub", async () => {
    window.history.replaceState(null, "", "/settings#desktop-only");

    render(<SettingsView />);

    expect(screen.queryByTestId("stub-desktop-only")).toBeNull();
    expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe(""));
  });

  it("lets the detached Settings shell own its drag region without launcher navigation", () => {
    const { container } = render(
      <SettingsView
        runtimeCapabilities={new Set(["detached-settings-shell"] as const)}
      />,
    );

    expect(container.querySelector(".settings-window-drag-strip")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
    fireEvent.click(hubRow("runtime"));
    expect(
      screen.getByRole("button", { name: "Back to Settings" }),
    ).toBeTruthy();
  });

  it("does not add detached-window chrome to embedded Settings", () => {
    const { container } = render(<SettingsView />);

    expect(container.querySelector(".settings-window-drag-strip")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Back to launcher" }),
    ).toBeTruthy();
  });

  it("keeps managed implementation controls available for local runtimes", () => {
    render(<SettingsView />);
    expect(hubRow("managed-hidden").textContent).toContain(
      "Managed implementation control",
    );
  });

  it("tapping a hub row opens that section as a subview under the same header", () => {
    render(<SettingsView />);

    fireEvent.click(hubRow("runtime"));

    // The section body is now mounted and the shared header retitles to it.
    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(
      screen
        .getByTestId("stub-runtime")
        .closest("[data-slot='settings-section-content']")?.className,
    ).toContain("!px-4");
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.getByTestId("view-header").textContent).toContain("Runtime");
    expect(screen.getByTestId("view-header").className).toContain("px-1.5");
    // The hub list is gone while a subview is open (true subview, not a rail).
    expect(screen.queryByTestId("settings-hub-list")).toBeNull();
    // Still exactly one header — the section did not stack a second one.
    expect(screen.getAllByTestId("view-header")).toHaveLength(1);
  });

  it("respects an initialSection prop by opening that section directly", () => {
    render(<SettingsView initialSection="runtime" />);

    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.getByTestId("view-header").textContent).toContain("Runtime");
  });

  it("synchronizes same-page settings navigation dispatched through popstate", () => {
    render(<SettingsView initialSection="identity" />);
    expect(screen.getByTestId("stub-identity")).toBeTruthy();

    window.history.pushState(null, "", "/settings#runtime");
    fireEvent(window, new PopStateEvent("popstate"));

    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
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

  it("ignores targeted generic permission priming in the Android Cloud build", () => {
    androidCloudBuildMock.isAndroidCloud = true;
    frontendPlatformMock.platform = "android";

    render(
      <SettingsView
        initialSection="runtime"
        navigatePayload={{
          permissionRequest: { permission: "microphone" },
        }}
        navigateSequence={1}
      />,
    );

    expect(screen.queryByTestId("permission-priming-modal")).toBeNull();
    expect(permissionPrimingMock.calls).toHaveLength(0);
  });

  it("exposes the account lifecycle section only in the Android Cloud build", () => {
    const hidden = render(
      <SettingsView initialSection="android-account-lifecycle" />,
    );
    expect(screen.queryByTestId("stub-android-account-lifecycle")).toBeNull();
    hidden.unmount();

    androidCloudBuildMock.isAndroidCloud = true;
    render(<SettingsView initialSection="android-account-lifecycle" />);
    expect(screen.getByTestId("stub-android-account-lifecycle")).toBeTruthy();
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

    // Back on the hub: header titled "Settings", hub list, no section body.
    expect(screen.getByTestId("view-header").textContent).toContain("Settings");
    expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
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

  // ── Responsive settings workspace ─────────────────────────────────────────

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

  it("renders Sayo's persistent rail and default work area at the shared 700px breakpoint", () => {
    const restore = mockMatchMedia((query) => query === "(min-width: 700px)");
    try {
      render(<SettingsView />);
      const navigation = screen.getByTestId("desktop-settings-navigation");
      expect(navigation).toBeTruthy();
      expect(screen.getByTestId("settings-shell").contains(navigation)).toBe(
        true,
      );
      expect(screen.getByTestId("desktop-settings-work-area")).toBeTruthy();
      const workArea = screen.getByTestId("desktop-settings-work-area");
      expect(workArea.getAttribute("data-slot")).toBe(
        "page-panel-content-rail",
      );
      expect(workArea.className).toContain("px-4");
      expect(workArea.className).toContain("sm:px-6");
      expect(screen.getByTestId("stub-identity")).toBeTruthy();
      expect(
        screen
          .getByTestId("stub-identity")
          .closest("[data-slot='settings-section-content']")?.className,
      ).not.toContain("!px-4");
      expect(
        screen
          .getByTestId("desktop-settings-item-identity")
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(screen.queryByTestId("settings-hub-list")).toBeNull();
      expect(screen.queryByTestId("view-header")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Back to launcher" }),
      ).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("nests the section title h1 inside the #<section.id> deep-link anchor on desktop", () => {
    // Regression guard (#16354): the persistent desktop rail moved the section
    // title into a header sibling ABOVE the section body, dropping it out of the
    // `#<section.id>` deep-link anchor. The title h1 + the body must share one
    // anchored container so a deep-link/screen-reader landing on the section
    // reaches its own title.
    const restore = mockMatchMedia((query) => query === "(min-width: 700px)");
    try {
      const { container } = render(<SettingsView initialSection="runtime" />);
      const anchor = container.querySelector<HTMLElement>("#runtime");
      expect(anchor).not.toBeNull();
      const scoped = within(anchor as HTMLElement);
      expect(scoped.getByRole("heading", { level: 1 }).textContent).toBe(
        "Runtime",
      );
      expect(scoped.getByTestId("stub-runtime")).toBeTruthy();
      // Exactly one element carries the anchor id (the wrapper), never a
      // duplicate on the inner body.
      expect(container.querySelectorAll("#runtime")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("keeps the section body as the deep-link anchor in the mobile subview", () => {
    const restore = mockMatchMedia(() => false);
    try {
      const { container } = render(<SettingsView initialSection="runtime" />);
      // Mobile keeps the shared ViewHeader title and anchors `#<id>` on the
      // section body (the default) — the body still contains the section's
      // rendered content.
      const anchor = container.querySelector<HTMLElement>("#runtime");
      expect(anchor).not.toBeNull();
      expect(
        within(anchor as HTMLElement).getByTestId("stub-runtime"),
      ).toBeTruthy();
      expect(screen.getByTestId("view-header").textContent).toContain(
        "Runtime",
      );
    } finally {
      restore();
    }
  });

  it("keeps the current hub list on a narrow mobile viewport", () => {
    const restore = mockMatchMedia(() => false);
    try {
      render(<SettingsView />);
      expect(hubRow("identity")).toBeTruthy();
      expect(screen.queryByTestId("stub-identity")).toBeNull();
      const header = screen.getByTestId("view-header");
      const scrollRegion = screen.getByTestId("settings-scroll-region");
      expect(screen.getAllByTestId("view-header")).toHaveLength(1);
      expect(scrollRegion.contains(header)).toBe(false);
      expect(
        header.compareDocumentPosition(scrollRegion) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(scrollRegion.className.includes("--eliza-chat-clearance")).toBe(
        false,
      );
      expect(
        screen.queryByTestId("page-layout-mobile-sidebar-trigger"),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps native iOS/Android on the compact hub at landscape widths", () => {
    frontendPlatformMock.platform = "android";
    const restore = mockMatchMedia((query) => query === "(min-width: 700px)");
    try {
      render(<SettingsView />);
      expect(screen.getByTestId("settings-hub-list")).toBeTruthy();
      expect(screen.queryByTestId("desktop-settings-navigation")).toBeNull();
      expect(screen.queryByTestId("stub-identity")).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps the compact 16px detail inset on wide native layouts", () => {
    frontendPlatformMock.platform = "android";
    const restore = mockMatchMedia((query) => query === "(min-width: 700px)");
    try {
      render(<SettingsView initialSection="runtime" />);
      expect(
        screen
          .getByTestId("stub-runtime")
          .closest("[data-slot='settings-section-content']")?.className,
      ).toContain("!px-4");
      expect(screen.queryByTestId("desktop-settings-work-area")).toBeNull();
    } finally {
      restore();
    }
  });
});
