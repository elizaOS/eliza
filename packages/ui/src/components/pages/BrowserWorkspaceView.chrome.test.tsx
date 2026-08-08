/**
 * Verifies the Browser view's fullscreen chrome contract: with the builtin
 * registry declaring `header: "fullscreen"`, the view owns its whole surface
 * and embedded page loads cannot take focus from the control that opened it.
 * Renders the real component in jsdom with deterministic workspace API data.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state")>();
  const state = {
    getStewardPending: () => null,
    getStewardStatus: () => null,
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
      getBrowserWorkspace: vi.fn().mockResolvedValue({ mode: "web", tabs: [] }),
      snapshotBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
    },
  };
});

import { client } from "../../api";
import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

const GOOGLE_WORKSPACE = {
  mode: "web" as const,
  tabs: [
    {
      id: "tab-1",
      title: "Google",
      url: "https://www.google.com/webhp?igu=1",
      partition: "persist:test",
      visible: true,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      lastFocusedAt: null,
    },
  ],
};

beforeEach(() => {
  vi.mocked(client.getBrowserWorkspace).mockResolvedValue({
    mode: "web",
    tabs: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BrowserWorkspaceView fullscreen chrome (Notes/Calendar parity)", () => {
  it("renders a main landmark with the view testid and NO shared ViewHeader row", async () => {
    render(<BrowserWorkspaceView />);
    // findBy: the designed-empty state lands after the mocked snapshot
    // resolves, keeping the async update inside act.
    expect(await screen.findByText("No page open")).not.toBeNull();
    const root = screen.getByTestId("browser-workspace-view");
    expect(root.tagName).toBe("MAIN");
    expect(root.getAttribute("aria-label")).toBe("Browser");
    // The fullscreen framing owns its chrome: the shared back-arrow ViewHeader
    // must not render (the shell no longer stacks a host top bar either).
    expect(screen.queryByTestId("view-header")).toBeNull();
  });

  it("floats the navigation toolbar as its own glass panel above the web surface", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();
    const toolbar = screen.getByTestId("browser-workspace-toolbar");
    // The glass material of the fullscreen pattern: translucent card fill +
    // backdrop blur, expressed as utility classes on the toolbar panel.
    expect(toolbar.className).toContain("backdrop-blur");
    // 24px (rounded-3xl) — the token-scale radius the Calendar panel uses.
    expect(toolbar.className).toContain("rounded-3xl");
    // The address bar lives inside the floating toolbar, not a page header.
    expect(
      toolbar.contains(screen.getByTestId("browser-workspace-address-input")),
    ).toBe(true);
  });

  it("returns delayed iframe autofocus to the control that opened Browser exactly once", async () => {
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(GOOGLE_WORKSPACE);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    try {
      render(<BrowserWorkspaceView />);
      const iframe = await screen.findByTitle("Google");
      iframe.focus();
      fireEvent.load(iframe);
      expect(document.activeElement).toBe(composer);

      // The return target is consumed by the initial app-requested load. A
      // later page navigation may keep focus inside the browser normally.
      iframe.focus();
      fireEvent.load(iframe);
      expect(document.activeElement).toBe(iframe);
    } finally {
      composer.remove();
    }
  });

  it("uses the Browser surface as a neutral focus target when no prior control exists", async () => {
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(GOOGLE_WORKSPACE);
    (document.activeElement as HTMLElement | null)?.blur();

    render(<BrowserWorkspaceView />);
    const iframe = await screen.findByTitle("Google");
    iframe.focus();
    fireEvent.load(iframe);

    expect(document.activeElement).toBe(
      screen.getByTestId("browser-workspace-view"),
    );
  });
});
