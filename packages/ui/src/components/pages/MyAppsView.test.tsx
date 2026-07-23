// @vitest-environment jsdom

/**
 * Tests for the standalone My Apps view: it mounts, shows its title, renders
 * the reused app-management surface (create + load entry points), and — as the
 * launcher's one apps destination — surfaces the Cloud Applications studio row
 * only when the native `cloud-apps` app-shell page is registered AND the user
 * is signed into Eliza Cloud. The app catalog client is mocked to empty so the
 * render is deterministic.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppShellPage } from "../../app-shell-registry";
import { resetUiRegistryHostForTests } from "../../registry-host";
import { __setAppValueForTests } from "../../state/app-store";
import { MyAppsView } from "./MyAppsView";

vi.mock("../../api/client", () => ({
  client: {
    listInstalledApps: vi.fn(async () => []),
    listAppRuns: vi.fn(async () => []),
    fetch: vi.fn(async () => ({})),
    launchApp: vi.fn(async () => ({})),
    stopApp: vi.fn(async () => ({})),
  },
}));

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

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  resetUiRegistryHostForTests();
  vi.clearAllMocks();
});

describe("MyAppsView", () => {
  it("renders the My Apps title and the app-management surface", async () => {
    seedAppValue();

    render(<MyAppsView />);

    expect(screen.getByRole("heading", { name: "My Apps" })).toBeTruthy();
    expect(
      screen.getByText("Install, create, and run your elizaOS apps."),
    ).toBeTruthy();
    // The reused management surface mounts and finishes its empty catalog load
    // (client.listInstalledApps is the mocked read) without throwing.
    const { client } = await import("../../api/client");
    await waitFor(() => expect(client.listInstalledApps).toHaveBeenCalled());
  });

  it("hides the Cloud Applications row when the studio page is not registered (web builds)", () => {
    seedAppValue({ elizaCloudConnected: true });

    render(<MyAppsView />);

    expect(studioRow()).toBeNull();
  });

  it("hides the Cloud Applications row while signed out of Eliza Cloud", () => {
    registerCloudAppsPage();
    seedAppValue({ elizaCloudConnected: false });

    render(<MyAppsView />);

    expect(studioRow()).toBeNull();
  });

  it("shows the Cloud Applications row when registered + signed in, and opens /cloud-apps", () => {
    registerCloudAppsPage();
    seedAppValue({ elizaCloudConnected: true });

    render(<MyAppsView />);

    const row = studioRow();
    expect(row).toBeTruthy();
    expect(screen.getByText("Eliza Cloud")).toBeTruthy();

    // Tapping the row navigates to the registered studio route — the same
    // destination the removed "Apps" launcher tile and the deep-link intent
    // (`eliza://apps/deploy`) open.
    fireEvent.click(row as HTMLElement);
    expect(window.location.pathname).toBe("/cloud-apps");
  });
});
