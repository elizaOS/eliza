// @vitest-environment jsdom

/**
 * Smoke test for the standalone My Apps view: it mounts, shows its title, and
 * renders the reused app-management surface (create + load entry points). The
 * app catalog client is mocked to empty so the render is deterministic.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("MyAppsView", () => {
  it("renders the My Apps title and the app-management surface", async () => {
    __setAppValueForTests({
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
      setActionNotice: vi.fn(),
    } as never);

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
});
