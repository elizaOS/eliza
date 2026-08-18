/**
 * Verifies the native-mobile-webview error surface distinguishes a permanent
 * WebView capability denial (LP3: system WebView 113 without multi-profile)
 * from a transient transport fault. Permanent shows honest "not supported"
 * copy with an Open-external escape hatch and NO Retry; transient keeps the
 * existing retryable state. The real component renders in jsdom; the surface
 * hook is harness-driven because the native transport does not exist here.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileNativeSurfaceError } from "../../surface/use-mobile-native-tab-surfaces";

const surfaceHarness = vi.hoisted(() => ({
  error: null as MobileNativeSurfaceError | null,
  retry: vi.fn(),
}));

const openExternalHarness = vi.hoisted(() => ({
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

// Force the native mobile shell so resolveBrowserTabRenderPath picks
// `native-mobile-webview` for the manifest's `native-webview` isolation.
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => true,
      getPlatform: () => "android",
    },
  };
});

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));

vi.mock(
  "../../surface/use-mobile-native-tab-surfaces",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../surface/use-mobile-native-tab-surfaces")
      >();
    return {
      ...actual,
      useMobileNativeTabSurfaces: () => ({
        registerSurfaceElement: vi.fn(),
        navigateSurface: vi.fn(),
        reloadSurface: vi.fn(),
        error: surfaceHarness.error,
        retry: surfaceHarness.retry,
      }),
    };
  },
);

vi.mock("../../utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils")>();
  return {
    ...actual,
    openExternalUrl: openExternalHarness.openExternalUrl,
  };
});

vi.mock("../../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state")>();
  const state = {
    getStewardPending: async () => [],
    getStewardStatus: async () => null,
    setActionNotice: vi.fn(),
    t: (
      _key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : _key,
    plugins: [],
    uiTheme: "dark",
    walletAddresses: [],
    walletConfig: null,
  };
  return {
    ...actual,
    useAppSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAppSelectorShallow: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    client: {
      ...actual.client,
      fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
      getWalletConfig: vi.fn().mockRejectedValue(new Error("no api in test")),
      getBrowserWorkspace: vi.fn().mockResolvedValue({
        mode: "web",
        tabs: [
          {
            id: "tab-1",
            title: "Example",
            url: "https://example.com/",
            partition: "persist:test",
            visible: true,
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            lastFocusedAt: null,
          },
        ],
      }),
      openBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      navigateBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      closeBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      snapshotBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
    },
  };
});

import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

beforeEach(() => {
  surfaceHarness.error = null;
  surfaceHarness.retry.mockClear();
  openExternalHarness.openExternalUrl.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("BrowserWorkspaceView native surface error states", () => {
  it("permanent capability denial: honest copy + Open external, NO Retry", async () => {
    surfaceHarness.error = {
      key: "browser-tab:tab-1:lifecycle",
      message:
        "isolated storage requires WebView multi-profile support; system WebView is too old",
      permanent: true,
    };
    render(<BrowserWorkspaceView />);
    expect(
      await screen.findByText("Secure browsing not supported here"),
    ).not.toBeNull();
    expect(
      screen.getByText(/system WebView cannot provide the isolation/),
    ).not.toBeNull();
    // Fail-closed with an escape hatch: no Retry that can never succeed.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Scope to the error card: the toolbar renders its own always-present
    // "Open external" icon button with the same accessible name.
    const alertCard = screen.getByRole("alert");
    const openExternal = within(alertCard).getByRole("button", {
      name: "Open external",
    });
    await act(async () => {
      fireEvent.click(openExternal);
    });
    expect(openExternalHarness.openExternalUrl).toHaveBeenCalledWith(
      "https://example.com/",
    );
    expect(surfaceHarness.retry).not.toHaveBeenCalled();
  });

  it("transient transport fault: existing retryable state is unchanged", async () => {
    surfaceHarness.error = {
      key: "browser-tab:tab-1:bounds",
      message: "bounds rejected",
      permanent: false,
    };
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("Browser view unavailable")).not.toBeNull();
    expect(screen.queryByText("Secure browsing not supported here")).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(surfaceHarness.retry).toHaveBeenCalledTimes(1);
    expect(openExternalHarness.openExternalUrl).not.toHaveBeenCalled();
  });
});
