// @vitest-environment jsdom
/**
 * Eliza's AOSP drawer reads and launches through the one shared System
 * launcher bridge: registered views open in the shell, installed apps reach
 * ElizaSystem by exact component, and a refused launch stays visible.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const system = vi.hoisted(() => ({
  calls: [] as [string, unknown][],
  refuse: new Set<string>(),
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: {
    listLauncherApps: async (options: unknown) => {
      system.calls.push(["listLauncherApps", options]);
      return {
        apps: [
          {
            packageName: "org.example.clock",
            activityName: "org.example.clock.Main",
            label: "Synthetic clock",
          },
        ],
      };
    },
    launchApp: async (target: { packageName: string }) => {
      system.calls.push(["launchApp", target]);
      if (system.refuse.has(target.packageName))
        throw Object.assign(new Error("App could not be opened"), {
          code: "failed",
        });
    },
    resolveDefaultApp: async () => ({ role: "dial", available: false }),
    openDefaultApp: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  },
}));

import { NativeInstalledAppsLauncher } from "../NativeInstalledAppsLauncher";

afterEach(() => {
  cleanup();
  system.calls.length = 0;
  system.refuse.clear();
});

describe("NativeInstalledAppsLauncher", () => {
  it("opens registered views in the shell and installed apps through ElizaSystem", async () => {
    const opened: string[] = [];
    render(
      <NativeInstalledAppsLauncher
        entries={[
          {
            id: "notes",
            label: "Notes",
            kind: "view",
          } as never,
        ]}
        onLaunch={(entry) => {
          opened.push(entry.id);
        }}
        error={null}
        loading={false}
        onRetry={() => {}}
      />,
    );
    const clock = await screen.findByRole("button", {
      name: "Open Synthetic clock",
    });
    expect(system.calls[0]).toEqual(["listLauncherApps", { icons: true }]);
    fireEvent.click(clock);
    await vi.waitFor(() =>
      expect(system.calls).toContainEqual([
        "launchApp",
        {
          packageName: "org.example.clock",
          activityName: "org.example.clock.Main",
        },
      ]),
    );
    // One launch at a time: the next tap is accepted once the first settled.
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Open Notes" })).toBeTruthy(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "Open Notes" }));
    await vi.waitFor(() => expect(opened).toEqual(["notes"]));
    // The registered view never reaches Android: only the clock was launched there.
    expect(
      system.calls.filter(([method]) => method === "launchApp"),
    ).toHaveLength(1);
  });

  it("keeps a refused launch visible and re-reads the inventory", async () => {
    system.refuse.add("org.example.clock");
    render(
      <NativeInstalledAppsLauncher
        entries={[]}
        onLaunch={() => {}}
        error={null}
        loading={false}
        onRetry={() => {}}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Synthetic clock" }),
    );
    expect(
      (await screen.findByRole("alert")).textContent?.startsWith(
        "Synthetic clock could not be opened.",
      ),
    ).toBe(true);
    expect(
      system.calls.filter(([method]) => method === "listLauncherApps").length,
    ).toBe(2);
  });
});
