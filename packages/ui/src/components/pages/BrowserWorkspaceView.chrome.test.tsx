/**
 * Verifies the Browser view's fullscreen chrome contract: with the builtin
 * registry declaring `header: "fullscreen"`, the view owns its whole surface
 * and embedded page loads cannot take focus from the control that opened it.
 * Renders the real component in jsdom with deterministic workspace API data.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      openBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      navigateBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
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

const APPLE_WORKSPACE = {
  mode: "web" as const,
  tabs: [
    {
      ...GOOGLE_WORKSPACE.tabs[0],
      id: "tab-apple",
      title: "Apple",
      url: "https://www.apple.com/",
    },
  ],
};

beforeEach(() => {
  vi.mocked(client.getBrowserWorkspace).mockResolvedValue({
    mode: "web",
    tabs: [],
  });
  vi.mocked(client.openBrowserWorkspaceTab).mockRejectedValue(
    new Error("no api in test"),
  );
  vi.mocked(client.navigateBrowserWorkspaceTab).mockRejectedValue(
    new Error("no api in test"),
  );
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

  it("returns autofocus that arrives after iframe load to the control that opened Browser", async () => {
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(GOOGLE_WORKSPACE);
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    try {
      render(<BrowserWorkspaceView />);
      const iframe = await screen.findByTitle("Google");
      fireEvent.load(iframe);
      iframe.focus();
      await waitFor(() => expect(document.activeElement).toBe(composer));

      // Hover is common while the user types in chat; it must not turn later
      // page autofocus into an apparent intentional frame interaction.
      fireEvent.pointerEnter(iframe);
      iframe.focus();
      await waitFor(() => expect(document.activeElement).toBe(composer));

      // A real pointer-down does transfer intent to the embedded page.
      fireEvent.pointerDown(iframe);
      iframe.focus();
      expect(document.activeElement).toBe(iframe);

      // A click inside an already-loaded cross-origin child does not bubble to
      // React. The parent observes the synchronous :active state at blur.
      composer.focus();
      fireEvent.load(iframe);
      const matches = iframe.matches.bind(iframe);
      const matchesSpy = vi
        .spyOn(iframe, "matches")
        .mockImplementation((selector) =>
          selector === ":active" ? true : matches(selector),
        );
      window.dispatchEvent(new FocusEvent("blur"));
      matchesSpy.mockRestore();
      iframe.focus();
      await new Promise((resolve) => setTimeout(resolve, 50));
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
    fireEvent.load(iframe);
    iframe.focus();

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("browser-workspace-view"),
      ),
    );
  });

  it("captures a focused address control before busy state disables it", async () => {
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(APPLE_WORKSPACE);
    vi.mocked(client.navigateBrowserWorkspaceTab).mockResolvedValue({
      tab: {
        ...APPLE_WORKSPACE.tabs[0],
        url: "https://example.com/",
      },
    });

    render(<BrowserWorkspaceView />);
    const iframe = await screen.findByTitle("Apple");
    fireEvent.pointerDown(iframe);
    const address = screen.getByTestId("browser-workspace-address-input");
    address.focus();
    fireEvent.change(address, { target: { value: "https://example.com/" } });
    await waitFor(() =>
      expect((address as HTMLInputElement).value).toBe("https://example.com/"),
    );
    fireEvent.keyDown(address, { key: "Enter" });

    await waitFor(() =>
      expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
        "tab-apple",
        "https://example.com/",
      ),
    );
    await waitFor(() => expect(address.hasAttribute("disabled")).toBe(false));
    fireEvent.load(iframe);
    iframe.focus();

    await waitFor(() => expect(document.activeElement).toBe(address));
  });

  it("opens a fresh Google home tab instead of cloning the active address", async () => {
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(APPLE_WORKSPACE);
    vi.mocked(client.openBrowserWorkspaceTab).mockResolvedValue({
      tab: GOOGLE_WORKSPACE.tabs[0],
    });

    render(<BrowserWorkspaceView />);
    expect(await screen.findByTitle("Apple")).not.toBeNull();
    fireEvent.click(screen.getByTestId("browser-workspace-nav-new-tab"));

    await waitFor(() =>
      expect(client.openBrowserWorkspaceTab).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://www.google.com/webhp?igu=1",
          show: true,
        }),
      ),
    );
  });
});
