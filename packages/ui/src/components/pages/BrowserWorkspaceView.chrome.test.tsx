/**
 * Verifies Browser fullscreen chrome, focus handoff, refresh precedence, and
 * wallet-origin authority. The real component renders in jsdom with
 * deterministic workspace API responses.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletStateHarness = vi.hoisted(() => ({
  connected: false,
  pendingApprovals: 0,
}));

vi.mock("../../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state")>();
  const state = {
    getStewardPending: async () =>
      Array.from(
        { length: walletStateHarness.pendingApprovals },
        (_, index) => ({
          queueId: `pending-${index}`,
        }),
      ),
    getStewardStatus: async () =>
      walletStateHarness.connected
        ? { available: true, configured: true, connected: true }
        : null,
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
      showBrowserWorkspaceTab: vi
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

import { client } from "../../api";
import { shellHistory } from "../../surface-realm-channel";
import { BrowserWorkspaceView } from "./BrowserWorkspaceView";
import {
  BROWSER_WALLET_READY_TYPE,
  BROWSER_WALLET_REQUEST_TYPE,
} from "./browser-workspace-wallet";

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

const EXAMPLE_WORKSPACE = {
  mode: "web" as const,
  tabs: [
    {
      ...APPLE_WORKSPACE.tabs[0],
      title: "Example",
      url: "https://example.com/",
    },
  ],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  walletStateHarness.connected = false;
  walletStateHarness.pendingApprovals = 0;
  vi.mocked(client.getBrowserWorkspace).mockResolvedValue({
    mode: "web",
    tabs: [],
  });
  vi.mocked(client.openBrowserWorkspaceTab).mockRejectedValue(
    new Error("no api in test"),
  );
  vi.mocked(client.showBrowserWorkspaceTab).mockRejectedValue(
    new Error("no api in test"),
  );
  vi.mocked(client.navigateBrowserWorkspaceTab).mockRejectedValue(
    new Error("no api in test"),
  );
  vi.mocked(client.closeBrowserWorkspaceTab).mockRejectedValue(
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

  it("opens a local app preview through the current Eliza UI origin", async () => {
    const previewPath = "/api/apps/local/nubs-color-pebble/";
    const previewUrl = `${window.location.origin}${previewPath}`;
    vi.mocked(client.openBrowserWorkspaceTab).mockResolvedValue({
      tab: {
        ...GOOGLE_WORKSPACE.tabs[0],
        id: "tab-preview",
        title: "Nubs Color Pebble",
        url: previewUrl,
      },
    });
    window.history.replaceState(
      {},
      "",
      `/browser?browse=${encodeURIComponent(previewPath)}`,
    );

    try {
      render(<BrowserWorkspaceView />);
      await waitFor(() =>
        expect(client.openBrowserWorkspaceTab).toHaveBeenCalledWith(
          expect.objectContaining({ url: previewUrl }),
        ),
      );
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("opens a requested preview when an already-mounted browser receives a new route", async () => {
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(GOOGLE_WORKSPACE);
    const previewPath = "/api/apps/local/nubs-color-pebble/";
    const previewUrl = `${window.location.origin}${previewPath}`;
    vi.mocked(client.openBrowserWorkspaceTab).mockResolvedValue({
      tab: {
        ...GOOGLE_WORKSPACE.tabs[0],
        id: "tab-preview",
        title: "Nubs Color Pebble",
        url: previewUrl,
      },
    });
    window.history.replaceState({}, "", "/browser");

    try {
      render(<BrowserWorkspaceView />);
      expect(
        await screen.findByDisplayValue(GOOGLE_WORKSPACE.tabs[0].url),
      ).not.toBeNull();

      window.history.pushState(
        {},
        "",
        `/browser?browse=${encodeURIComponent(previewPath)}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));

      await waitFor(() =>
        expect(client.openBrowserWorkspaceTab).toHaveBeenCalledWith(
          expect.objectContaining({ url: previewUrl }),
        ),
      );
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("reloads an existing app preview when the same browse route is requested again", async () => {
    const previewPath = "/api/apps/local/nubs-color-pebble/";
    const previewUrl = `${window.location.origin}${previewPath}`;
    const previewTab = {
      ...GOOGLE_WORKSPACE.tabs[0],
      id: "tab-preview",
      title: "Nubs Color Pebble",
      url: previewUrl,
    };
    const previewWorkspace = { mode: "web" as const, tabs: [previewTab] };
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(previewWorkspace);
    vi.mocked(client.showBrowserWorkspaceTab).mockResolvedValue({
      tab: previewTab,
    });
    window.history.replaceState(
      {},
      "",
      `/browser?browse=${encodeURIComponent(previewPath)}`,
    );

    try {
      render(<BrowserWorkspaceView />);
      await waitFor(() =>
        expect(client.showBrowserWorkspaceTab).toHaveBeenCalledTimes(1),
      );
      const firstFrame = screen.getByTitle("Nubs Color Pebble");

      act(() => {
        window.history.pushState(
          {},
          "",
          `/browser?browse=${encodeURIComponent(previewPath)}`,
        );
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await waitFor(() =>
        expect(client.showBrowserWorkspaceTab).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(screen.getByTitle("Nubs Color Pebble")).not.toBe(firstFrame),
      );
    } finally {
      window.history.replaceState({}, "", "/");
    }
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
    const back = screen.getByRole("button", { name: "Back to launcher" });
    expect(toolbar.contains(back)).toBe(true);
    expect(back.className).toMatch(/(?:^|\s)h-11(?:\s|$)/);
  });

  it("invokes launcher navigation once from the toolbar back button", async () => {
    const pushState = vi
      .spyOn(shellHistory, "pushState")
      .mockImplementation(() => {});
    try {
      render(<BrowserWorkspaceView />);
      expect(await screen.findByText("No page open")).not.toBeNull();
      const toolbar = screen.getByTestId("browser-workspace-toolbar");
      const back = screen.getByRole("button", { name: "Back to launcher" });
      expect(toolbar.contains(back)).toBe(true);
      fireEvent.click(back);
      expect(pushState).toHaveBeenCalledTimes(1);
      expect(pushState).toHaveBeenCalledWith(null, "", "/views");
    } finally {
      pushState.mockRestore();
    }
  });

  it("reserves the measured resting chat footprint and safe-area stack from the page viewport", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();

    const root = screen.getByTestId("browser-workspace-view");
    const surface = screen.getByTestId("browser-workspace-surface-panel");
    expect(root.getAttribute("data-chat-clearance-aware")).toBe("true");
    expect(root.className).toContain("--eliza-chat-clearance");
    expect(root.className).toContain("--eliza-mobile-nav-offset");
    expect(root.className).toContain("--safe-area-bottom");
    expect(root.className).toContain("--android-gesture-inset-bottom");
    expect(root.contains(surface)).toBe(true);
  });

  it("uses a compact two-row mobile toolbar without shrinking any navigation target below 44px", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();

    const toolbar = screen.getByTestId("browser-workspace-toolbar");
    const nav = toolbar.firstElementChild as HTMLElement | null;
    expect(nav).not.toBeNull();
    expect(nav?.className).toContain("grid-cols-");
    expect(nav?.className).toContain("md:grid-cols-");
    expect(nav?.className).not.toContain("sm:grid-cols-");
    expect(nav?.className).toContain("gap-1");
    expect(nav?.className).toContain("py-1");

    expect(
      screen.getByTestId("browser-workspace-address-input").className,
    ).toContain("col-span-2");
    expect(
      screen.getByTestId("browser-workspace-address-input").className,
    ).toContain("md:col-span-1");
    expect(
      screen.getByTestId("browser-workspace-address-input").className,
    ).not.toContain("sm:col-span-1");
    for (const control of toolbar.querySelectorAll("button, input")) {
      expect(control.className).toMatch(/(?:h-11|min-h-11)/);
    }
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
    // The iframe can mount before the active-tab URL synchronization effect
    // has committed. Wait for that initial value so the effect cannot overwrite
    // the simulated edit on a loaded runner.
    await waitFor(() =>
      expect((address as HTMLInputElement).value).toBe(
        "https://www.apple.com/",
      ),
    );
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
    // Loaded CI runners stretch the busy→enabled transition and the
    // focus-restore effect past waitFor's 1s default; the contract is the
    // transition itself, so give it a bounded but generous budget.
    await waitFor(() => expect(address.hasAttribute("disabled")).toBe(false), {
      timeout: 10_000,
    });
    fireEvent.load(iframe);
    iframe.focus();

    await waitFor(() => expect(document.activeElement).toBe(address), {
      timeout: 10_000,
    });
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

  it("keeps transient background refresh timeouts off a healthy page and retries single-flight", async () => {
    vi.useFakeTimers();
    const pendingRefresh = deferred<typeof GOOGLE_WORKSPACE>();
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockResolvedValueOnce(GOOGLE_WORKSPACE)
      .mockImplementationOnce(() => pendingRefresh.promise)
      .mockResolvedValueOnce(APPLE_WORKSPACE);

    try {
      render(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTitle("Google")).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_500);
      });
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(2);

      await act(async () => {
        pendingRefresh.reject(new Error("Request timed out after 10000ms"));
        await Promise.resolve();
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTitle("Google")).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(3);
      expect(screen.getByTitle("Apple")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an explicit action refresh failure observable", async () => {
    vi.mocked(client.getBrowserWorkspace)
      .mockResolvedValueOnce(APPLE_WORKSPACE)
      .mockRejectedValueOnce(new Error("Explicit refresh failed"));
    vi.mocked(client.openBrowserWorkspaceTab).mockResolvedValue({
      tab: GOOGLE_WORKSPACE.tabs[0],
    });

    render(<BrowserWorkspaceView />);
    expect(await screen.findByTitle("Apple")).not.toBeNull();
    fireEvent.click(screen.getByTestId("browser-workspace-nav-new-tab"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Explicit refresh failed",
    );
  });

  it("shows an initial load failure until a later background retry succeeds", async () => {
    vi.useFakeTimers();
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockRejectedValueOnce(new Error("Initial workspace load failed"))
      .mockResolvedValueOnce(APPLE_WORKSPACE);

    try {
      render(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("alert").textContent).toContain(
        "Initial workspace load failed",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(screen.getByTitle("Apple")).not.toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the StrictMode initial load single-flight and loading until it settles", async () => {
    const pendingInitialLoad = deferred<typeof APPLE_WORKSPACE>();
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockImplementation(() => pendingInitialLoad.promise);

    render(<BrowserWorkspaceView />, { reactStrictMode: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading browser workspace")).not.toBeNull();
    expect(screen.queryByText("No page open")).toBeNull();

    await act(async () => {
      pendingInitialLoad.resolve(APPLE_WORKSPACE);
      await Promise.resolve();
    });
    expect(screen.getByTitle("Apple")).not.toBeNull();
    expect(screen.queryByText("Loading browser workspace")).toBeNull();
  });

  it("does not let a stale background response overwrite a newer navigation", async () => {
    vi.useFakeTimers();
    const pendingRefresh = deferred<typeof GOOGLE_WORKSPACE>();
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockResolvedValueOnce(APPLE_WORKSPACE)
      .mockImplementationOnce(() => pendingRefresh.promise)
      .mockResolvedValueOnce(EXAMPLE_WORKSPACE);
    vi.mocked(client.navigateBrowserWorkspaceTab).mockResolvedValue({
      tab: EXAMPLE_WORKSPACE.tabs[0],
    });

    try {
      render(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTitle("Apple")).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(2);

      const address = screen.getByTestId("browser-workspace-address-input");
      await act(async () => {
        fireEvent.change(address, {
          target: { value: "https://example.com/" },
        });
        fireEvent.keyDown(address, { key: "Enter" });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(3);
      expect(screen.getByTitle("Example")).not.toBeNull();

      await act(async () => {
        pendingRefresh.resolve(GOOGLE_WORKSPACE);
        await Promise.resolve();
      });
      expect(screen.getByTitle("Example")).not.toBeNull();
      expect(screen.queryByTitle("Google")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates wallet authority before iframe navigation and revokes it before closed-frame removal", async () => {
    const navigationSnapshot = deferred<typeof EXAMPLE_WORKSPACE>();
    const closedSnapshot = deferred<{ mode: "web"; tabs: [] }>();
    let workspaceRead = 0;
    vi.mocked(client.getBrowserWorkspace).mockImplementation(() => {
      workspaceRead += 1;
      if (workspaceRead === 1) return Promise.resolve(APPLE_WORKSPACE);
      if (workspaceRead === 2) return navigationSnapshot.promise;
      return closedSnapshot.promise;
    });
    vi.mocked(client.navigateBrowserWorkspaceTab).mockResolvedValue({
      tab: EXAMPLE_WORKSPACE.tabs[0],
    });
    vi.mocked(client.closeBrowserWorkspaceTab).mockResolvedValue({
      closed: true,
    });

    render(<BrowserWorkspaceView />);
    const iframe = (await screen.findByTitle("Apple")) as HTMLIFrameElement;
    const postMessageCalls: Array<[unknown, string]> = [];
    const spiedWindows = new Set<Window>();
    const spyFrameWindow = () => {
      const frameWindow = iframe.contentWindow as Window;
      if (!spiedWindows.has(frameWindow)) {
        spiedWindows.add(frameWindow);
        vi.spyOn(frameWindow, "postMessage").mockImplementation(
          (message, targetOrigin) => {
            postMessageCalls.push([message, String(targetOrigin)]);
          },
        );
      }
    };
    spyFrameWindow();
    const readyCalls = () =>
      postMessageCalls.filter(
        ([message]) =>
          (message as { type?: unknown }).type === BROWSER_WALLET_READY_TYPE,
      );
    const requestState = async (origin: string, requestId: string) => {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: BROWSER_WALLET_REQUEST_TYPE,
              requestId,
              method: "getState",
            },
            origin,
            source: iframe.contentWindow,
          }),
        );
        await Promise.resolve();
      });
    };

    await requestState("https://www.apple.com", "ready-a");
    expect(readyCalls()).toHaveLength(1);

    const address = screen.getByTestId("browser-workspace-address-input");
    fireEvent.change(address, {
      target: { value: EXAMPLE_WORKSPACE.tabs[0].url },
    });
    fireEvent.keyDown(address, { key: "Enter" });
    await waitFor(() =>
      expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
        "tab-apple",
        EXAMPLE_WORKSPACE.tabs[0].url,
      ),
    );
    await waitFor(() => expect(iframe.src).toBe(EXAMPLE_WORKSPACE.tabs[0].url));
    expect(screen.getByTitle("Apple")).toBe(iframe);
    spyFrameWindow();

    await requestState("https://example.com", "ready-b");
    expect(readyCalls()).toHaveLength(2);
    expect(readyCalls().at(-1)?.[1]).toBe("https://example.com");
    await requestState("https://www.apple.com", "stale-a");
    expect(readyCalls()).toHaveLength(2);
    await requestState("https://example.com", "duplicate-b");
    expect(readyCalls()).toHaveLength(2);

    navigationSnapshot.resolve(EXAMPLE_WORKSPACE);
    expect(await screen.findByTitle("Example")).toBe(iframe);
    expect(readyCalls()).toHaveLength(2);

    fireEvent.click(screen.getByTestId("browser-workspace-close-all-tabs"));
    await waitFor(() =>
      expect(client.closeBrowserWorkspaceTab).toHaveBeenCalledWith("tab-apple"),
    );
    await waitFor(() =>
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(3),
    );
    const callsBeforeClosedRequest = postMessageCalls.length;
    await requestState("https://example.com", "closed-b");
    expect(postMessageCalls).toHaveLength(callsBeforeClosedRequest);

    closedSnapshot.resolve({ mode: "web", tabs: [] });
    expect(await screen.findByText("No page open")).not.toBeNull();
  });

  it("preserves wallet readiness when Go resolves to the already-loaded URL", async () => {
    vi.useFakeTimers();
    walletStateHarness.connected = true;
    walletStateHarness.pendingApprovals = 1;
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(APPLE_WORKSPACE);
    vi.mocked(client.navigateBrowserWorkspaceTab).mockResolvedValue({
      tab: APPLE_WORKSPACE.tabs[0],
    });

    try {
      render(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const iframe = screen.getByTitle("Apple") as HTMLIFrameElement;
      const postMessage = vi
        .spyOn(iframe.contentWindow as Window, "postMessage")
        .mockImplementation(() => undefined);
      const readyCalls = () =>
        postMessage.mock.calls.filter(
          ([message]) =>
            (message as { type?: unknown }).type === BROWSER_WALLET_READY_TYPE,
        );

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: BROWSER_WALLET_REQUEST_TYPE,
              requestId: "prove-loaded-origin",
              method: "getState",
            },
            origin: "https://www.apple.com",
            source: iframe.contentWindow,
          }),
        );
        await Promise.resolve();
      });
      expect(readyCalls()).toHaveLength(1);
      expect(readyCalls().at(-1)).toEqual([
        {
          type: BROWSER_WALLET_READY_TYPE,
          state: expect.objectContaining({ pendingApprovals: 1 }),
        },
        "https://www.apple.com",
      ]);

      const address = screen.getByTestId("browser-workspace-address-input");
      await act(async () => {
        fireEvent.keyDown(address, { key: "Enter" });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
        "tab-apple",
        APPLE_WORKSPACE.tabs[0].url,
      );
      expect(iframe.src).toBe(APPLE_WORKSPACE.tabs[0].url);

      walletStateHarness.pendingApprovals = 2;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.resolve();
      });
      expect(readyCalls()).toHaveLength(2);
      expect(readyCalls().at(-1)).toEqual([
        {
          type: BROWSER_WALLET_READY_TYPE,
          state: expect.objectContaining({ pendingApprovals: 2 }),
        },
        "https://www.apple.com",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
