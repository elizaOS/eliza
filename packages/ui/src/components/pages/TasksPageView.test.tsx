/** Verifies TasksPageView through the package's configured test harness. */
// @vitest-environment jsdom
//
// Structural tests for the consolidated Projects surface (#13565 views-redesign
// epic, #17031 My Apps consolidation): the Projects nav tab hosts the
// coding-agent tasks panel AND the app inventory behind one segmented control
// under the shared, uniform `ViewHeader`. We assert (a) the shell `ViewHeader`
// renders with the centered "Projects" title and its icon-only back button,
// (b) the tasks panel is mounted in `fullPage` mode so it suppresses its own
// internal title row, (c) the Apps segment renders the reused app-management
// surface plus the cloud-gated Cloud Applications studio row, and (d) retired
// My Apps deep links pre-select the Apps segment. The panel + shell surface are
// mocked to isolate the host's composition from the panel's data behavior; the
// app catalog client is mocked to empty so renders are deterministic.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppShellPage } from "../../app-shell-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { __setAppValueForTests } from "../../state/app-store";

const panelProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

// The slot indirection resolves to the real coding-agent panel at runtime; here
// we stub it so the test asserts what props the host passes, not panel internals.
vi.mock("../../slots/task-coordinator-slots.js", () => ({
  CodingAgentTasksPanel: (props: Record<string, unknown>) => {
    panelProps.value = props;
    return <div data-testid="coding-agent-tasks-panel-stub" />;
  },
}));

vi.mock("../../api/client", () => ({
  client: {
    listInstalledApps: vi.fn(async () => []),
    listAppRuns: vi.fn(async () => []),
    fetch: vi.fn(async () => ({})),
    launchApp: vi.fn(async () => ({})),
    stopApp: vi.fn(async () => ({})),
  },
}));

import { initialProjectsSegmentForPath, TasksPageView } from "./TasksPageView";

function seedAppValue(over: Record<string, unknown> = {}): void {
  __setAppValueForTests({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    setActionNotice: vi.fn(),
    elizaCloudConnected: false,
    ...over,
  } as never);
}

/** The `cloud-apps` registration `@elizaos/app` installs on native shells. */
function registerCloudAppsPage(): void {
  registerAppShellPage({
    id: "cloud-apps",
    pluginId: "@elizaos/app",
    label: "Cloud Apps",
    icon: "Grid3x3",
    path: "/cloud-apps",
    viewKind: "release",
    loader: async () => ({ default: () => null }),
  });
}

const studioRow = () => screen.queryByTestId("my-apps-cloud-studio-row");

function openAppsSegment(): void {
  fireEvent.click(screen.getByTestId("projects-segment-apps"));
}

afterEach(() => {
  cleanup();
  panelProps.value = null;
  __setAppValueForTests(null);
  resetUiRegistryHostForTests();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("TasksPageView", () => {
  it("renders the shared ViewHeader with a centered 'Projects' title", () => {
    seedAppValue();
    render(<TasksPageView />);
    const header = screen.getByTestId("view-header");
    expect(header).toBeTruthy();
    // The heading text lives in the ViewHeader's <h1>, not the panel.
    const heading = within(header).getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Projects");
  });

  it("exposes the icon-only launcher back control from the header", () => {
    seedAppValue();
    render(<TasksPageView />);
    // ViewBackButton is aria-labeled and icon-only (no visible text label).
    const back = screen.getByRole("button", { name: /back to launcher/i });
    expect(back).toBeTruthy();
    expect(back.textContent?.trim()).toBe("");
  });

  it("mounts the tasks panel in fullPage mode (panel suppresses its own header)", () => {
    seedAppValue();
    render(<TasksPageView />);
    expect(screen.getByTestId("coding-agent-tasks-panel-stub")).toBeTruthy();
    expect(panelProps.value).toMatchObject({ fullPage: true });
  });

  it("wraps the view with the tasks-view test id", () => {
    seedAppValue();
    render(<TasksPageView />);
    expect(screen.getByTestId("tasks-view")).toBeTruthy();
  });

  it("switches to the Apps segment and renders the app-management surface", async () => {
    seedAppValue();
    render(<TasksPageView />);
    expect(screen.getByTestId("coding-agent-tasks-panel-stub")).toBeTruthy();

    openAppsSegment();

    expect(screen.getByTestId("projects-apps-segment")).toBeTruthy();
    expect(screen.queryByTestId("coding-agent-tasks-panel-stub")).toBeNull();
    expect(screen.getByRole("region", { name: "App actions" })).toBeTruthy();
    // The reused management surface mounts and finishes its empty catalog load
    // (client.listInstalledApps is the mocked read) without throwing.
    const { client } = await import("../../api/client");
    await waitFor(() => expect(client.listInstalledApps).toHaveBeenCalled());
  });

  it("hides the Cloud Applications row when the studio page is not registered (web builds)", () => {
    seedAppValue({ elizaCloudConnected: true });
    render(<TasksPageView />);
    openAppsSegment();
    expect(studioRow()).toBeNull();
  });

  it("hides the Cloud Applications row while signed out of Eliza Cloud", () => {
    registerCloudAppsPage();
    seedAppValue({ elizaCloudConnected: false });
    render(<TasksPageView />);
    openAppsSegment();
    expect(studioRow()).toBeNull();
  });

  it("shows the Cloud Applications row when registered + signed in, and opens /cloud-apps", () => {
    registerCloudAppsPage();
    seedAppValue({ elizaCloudConnected: true });
    render(<TasksPageView />);
    openAppsSegment();

    const row = studioRow();
    expect(row).toBeTruthy();
    expect(screen.getByText("Eliza Cloud")).toBeTruthy();

    // Tapping the row navigates to the registered studio route — the same
    // destination the retired "Apps" launcher tile and the deep-link intent
    // (`eliza://apps/deploy`) open.
    fireEvent.click(row as HTMLElement);
    expect(window.location.pathname).toBe("/cloud-apps");
  });

  it("pre-selects the Apps segment for retired My Apps deep links", () => {
    seedAppValue();
    window.history.replaceState(null, "", "/apps");
    render(<TasksPageView />);
    expect(screen.getByTestId("projects-apps-segment")).toBeTruthy();
    expect(screen.queryByTestId("coding-agent-tasks-panel-stub")).toBeNull();
  });

  it("pre-selects Apps for packaged hash routes and follows same-tab route changes", () => {
    seedAppValue();
    window.history.replaceState(null, "", "/?appWindow=1#/apps");
    render(<TasksPageView />);
    expect(screen.getByTestId("projects-apps-segment")).toBeTruthy();

    act(() => {
      window.location.hash = "#/apps/tasks";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(screen.getByTestId("coding-agent-tasks-panel-stub")).toBeTruthy();

    act(() => {
      window.location.hash = "#/apps/my-apps";
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(screen.getByTestId("projects-apps-segment")).toBeTruthy();
  });

  it("maps retired and canonical paths to the right initial segment", () => {
    expect(initialProjectsSegmentForPath("/apps")).toBe("apps");
    expect(initialProjectsSegmentForPath("/apps/")).toBe("apps");
    expect(initialProjectsSegmentForPath("/apps/my-apps")).toBe("apps");
    expect(initialProjectsSegmentForPath("/base/apps")).toBe("apps");
    expect(initialProjectsSegmentForPath("/apps/tasks")).toBe("tasks");
    expect(initialProjectsSegmentForPath("/")).toBe("tasks");
    expect(initialProjectsSegmentForPath("")).toBe("tasks");
  });
});
