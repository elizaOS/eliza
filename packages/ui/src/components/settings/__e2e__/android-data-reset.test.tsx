/**
 * "Reset app data" in Settings is Android-only and asks the native review for
 * everything: the row exists only in the Android app whose host registered
 * `ElizaDataReset`, calls `review()` with no arguments, and only ever reports
 * that nothing was reset.
 */
// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import type { DataResetPlugin } from "@elizaos/capacitor-system/reset";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitor = vi.hoisted(() => ({
  platform: "web",
  plugins: new Set<string>(),
  registered: [] as string[],
  review: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitor.platform,
    isPluginAvailable: (name: string) => capacitor.plugins.has(name),
  },
  registerPlugin: (name: string) => {
    capacitor.registered.push(name);
    return { review: capacitor.review };
  },
}));

import {
  ANDROID_DATA_RESET_PLUGIN,
  AndroidDataResetGroup,
  isAndroidDataResetAvailable,
} from "../AndroidDataResetGroup";

const ROW = "settings-reset-app-data";

beforeEach(() => {
  capacitor.platform = "web";
  capacitor.plugins = new Set();
  capacitor.review.mockReset();
});
afterEach(() => {
  cleanup();
  delete (window as { __electrobunWindowId?: unknown }).__electrobunWindowId;
});

describe("Reset app data availability", () => {
  it("is offered only on Android with the native host plugin", () => {
    const probe = (platform: string, registered: boolean) =>
      isAndroidDataResetAvailable({
        platform: () => platform,
        pluginAvailable: (name) =>
          registered && name === ANDROID_DATA_RESET_PLUGIN,
      });
    expect(probe("android", true)).toBe(true);
    expect(probe("android", false)).toBe(false);
    for (const platform of ["web", "ios", "desktop"]) {
      expect(probe(platform, true)).toBe(false);
    }
    expect(
      isAndroidDataResetAvailable({
        platform: () => {
          throw new Error("no bridge");
        },
        pluginAvailable: () => true,
      }),
    ).toBe(false);
  });

  it("reads the Capacitor platform and plugin registry by default", () => {
    capacitor.plugins.add(ANDROID_DATA_RESET_PLUGIN);
    for (const platform of ["web", "ios"]) {
      capacitor.platform = platform;
      const { unmount } = render(<AndroidDataResetGroup />);
      expect(screen.queryByTestId(ROW)).toBeNull();
      unmount();
    }
    capacitor.platform = "android";
    capacitor.plugins.clear();
    const withoutHost = render(<AndroidDataResetGroup />);
    expect(screen.queryByTestId(ROW)).toBeNull();
    withoutHost.unmount();

    capacitor.plugins.add(ANDROID_DATA_RESET_PLUGIN);
    render(<AndroidDataResetGroup />);
    expect(screen.getByTestId(ROW).textContent).toContain("Reset app data");
    expect(capacitor.registered).toContain("ElizaDataReset");
  });

  it("stays hidden in the desktop shell, which has its own Reset App flow", () => {
    capacitor.platform = "android";
    capacitor.plugins.add(ANDROID_DATA_RESET_PLUGIN);
    (window as { __electrobunWindowId?: unknown }).__electrobunWindowId = 1;
    render(<AndroidDataResetGroup />);
    expect(screen.queryByTestId(ROW)).toBeNull();
  });
});

describe("Reset app data review", () => {
  const android = {
    platform: () => "android",
    pluginAvailable: () => true,
  };

  it("opens the native review with no arguments and shows its answer", async () => {
    const review = vi.fn<DataResetPlugin["review"]>(async () => ({
      status: "cancelled",
      message: "Reset cancelled. Nothing reset.",
    }));
    render(<AndroidDataResetGroup probes={android} plugin={{ review }} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId(ROW));
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe(
      "Reset cancelled. Nothing reset.",
    );
  });

  it("never reports a completed reset, whatever the bridge answers", async () => {
    const review = vi.fn<DataResetPlugin["review"]>(async () => ({
      status: "completed",
      message: "All data deleted.",
    }));
    render(<AndroidDataResetGroup probes={android} plugin={{ review }} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId(ROW));
    });
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).not.toContain("deleted");
    expect(status).toMatch(/No completed reset is confirmed/);
  });

  it("opens one review at a time", async () => {
    let finish: (value: { status: string; message: string }) => void = () => {};
    const review = vi.fn<DataResetPlugin["review"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<AndroidDataResetGroup probes={android} plugin={{ review }} />);
    const row = screen.getByTestId(ROW);
    await act(async () => {
      fireEvent.click(row);
      fireEvent.click(row);
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect((row as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish({ status: "unavailable", message: "A reset review is already open." });
    });
    expect((row as HTMLButtonElement).disabled).toBe(false);
  });
});

it("is mounted in the Backups section", () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "AdvancedSection.tsx"),
    "utf8",
  );
  expect(source).toContain("<AndroidDataResetGroup />");
});
