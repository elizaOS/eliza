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
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletStateHarness = vi.hoisted(() => ({
  connected: false,
  pendingApprovals: 0,
  plugins: [] as Array<{ name: string }>,
}));

const apiBaseHarness = vi.hoisted(() => ({
  base: "https://remote-agent.example/api-root",
}));

const authorityState = vi.hoisted(() => ({
  value: "profile-a\u0000https://same-agent.test",
}));

const openExternalUrlMock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityState.value,
}));

vi.mock("../../utils/asset-url", () => ({
  resolveApiUrl: (path: string) => `${apiBaseHarness.base}${path}`,
}));

vi.mock("../../utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils")>();
  return {
    ...actual,
    openExternalUrl: openExternalUrlMock,
  };
});

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
    plugins: walletStateHarness.plugins,
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
import { ApiError } from "../../api/client-types-core";
import { shellHistory } from "../../surface-realm-channel";
import {
  BrowserWorkspaceView,
  normalizeBrowserWorkspaceInputUrl,
} from "./BrowserWorkspaceView";
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
  authorityState.value = "profile-a\u0000https://same-agent.test";
  walletStateHarness.connected = false;
  walletStateHarness.pendingApprovals = 0;
  walletStateHarness.plugins.splice(0);
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
  vi.mocked(client.closeBrowserWorkspaceTab).mockRejectedValue(
    new Error("no api in test"),
  );
  vi.mocked(client.snapshotBrowserWorkspaceTab)
    .mockReset()
    .mockRejectedValue(new Error("no api in test"));
  openExternalUrlMock.mockReset();
  openExternalUrlMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Browser workspace URL normalization", () => {
  const translate = (key: string, vars?: Record<string, unknown>): string =>
    String(vars?.defaultValue ?? key);

  it("resolves local app paths against the active remote agent API base", () => {
    expect(
      normalizeBrowserWorkspaceInputUrl("/api/apps/local/demo/", translate),
    ).toBe("https://remote-agent.example/api-root/api/apps/local/demo/");
  });

  it("preserves external http(s) and adds https to a schemeless host", () => {
    expect(
      normalizeBrowserWorkspaceInputUrl("https://example.com/a", translate),
    ).toBe("https://example.com/a");
    expect(normalizeBrowserWorkspaceInputUrl("example.com/a", translate)).toBe(
      "https://example.com/a",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,no",
    "http://[",
    "//evil.example/path",
    "/\\evil.example/path",
  ])("rejects an unsafe or malformed target: %s", (url) => {
    expect(() => normalizeBrowserWorkspaceInputUrl(url, translate)).toThrow();
  });
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

  it("keeps bridge recovery reachable without adding idle administration UI", async () => {
    walletStateHarness.plugins.push({ name: "@elizaos/plugin-browser" });
    render(<BrowserWorkspaceView />);

    expect(await screen.findByText("No page open")).not.toBeNull();
    expect(screen.queryByTestId("browser-bridge-controls")).toBeNull();
    expect(screen.queryByText("Install Agent Browser Bridge")).toBeNull();
    expect(
      await screen.findByTestId("browser-session-policy-error"),
    ).not.toBeNull();
  });

  it("keeps bridge recovery reachable while a browser tab is open", async () => {
    walletStateHarness.plugins.push({ name: "@elizaos/plugin-browser" });
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(GOOGLE_WORKSPACE);
    render(<BrowserWorkspaceView />);

    expect(await screen.findByTitle("Google")).not.toBeNull();
    expect(
      await screen.findByTestId("browser-session-policy-error"),
    ).not.toBeNull();
    expect(screen.getByTestId("browser-session-policy-dock")).not.toBeNull();
  });

  it("keeps one flat navigation rail above the web surface", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();
    const toolbar = screen.getByTestId("browser-workspace-toolbar");
    expect(toolbar.className).not.toContain("backdrop-blur");
    expect(toolbar.className).toContain("rounded-2xl");
    expect(toolbar.className).toContain("border-border");
    expect(toolbar.className).toContain("bg-card");
    expect(
      toolbar.contains(screen.getByTestId("browser-workspace-address-input")),
    ).toBe(true);
    const back = screen.getByRole("button", { name: "Back to launcher" });
    expect(toolbar.contains(back)).toBe(true);
    expect(back.className).toMatch(/(?:^|\s)(?:h-11|size-11)(?:\s|$)/);
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

  it("reserves the measured resting chat footprint without duplicating the workspace safe-area floor", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();

    const root = screen.getByTestId("browser-workspace-view");
    const surface = screen.getByTestId("browser-workspace-surface-panel");
    expect(root.getAttribute("data-chat-clearance-aware")).toBe("true");
    expect(root.className).toContain("--eliza-chat-clearance");
    expect(root.className).not.toContain("--eliza-mobile-nav-offset");
    expect(root.className).not.toContain("--safe-area-bottom");
    expect(root.className).not.toContain("--android-gesture-inset-bottom");
    expect(root.contains(surface)).toBe(true);
  });

  it("exposes the folded mobile actions through a named menu and opens a new tab", async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockResolvedValueOnce({ mode: "web", tabs: [] })
      .mockResolvedValue(GOOGLE_WORKSPACE);
    vi.mocked(client.openBrowserWorkspaceTab).mockResolvedValue({
      tab: GOOGLE_WORKSPACE.tabs[0],
    });

    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();

    const trigger = screen.getByRole("button", {
      name: "More browser actions",
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const newTab = await screen.findByRole("menuitem", { name: "New tab" });
    expect(newTab.getAttribute("aria-disabled")).not.toBe("true");
    for (const unavailableAction of [
      "Refresh",
      "Close all tabs",
      "Open external",
    ]) {
      expect(
        screen
          .getByRole("menuitem", { name: unavailableAction })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    }

    await user.click(newTab);

    await waitFor(() =>
      expect(client.openBrowserWorkspaceTab).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://www.google.com/webhp?igu=1",
          show: true,
        }),
      ),
    );
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("dispatches refresh, external-open, and close-all from the mobile action menu", async () => {
    const user = userEvent.setup({ delay: null });
    const cloudWorkspace = { ...APPLE_WORKSPACE, mode: "cloud" as const };
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockResolvedValueOnce(cloudWorkspace)
      .mockResolvedValue({ mode: "cloud", tabs: [] });
    vi.mocked(client.navigateBrowserWorkspaceTab).mockResolvedValue({
      tab: cloudWorkspace.tabs[0],
    });
    vi.mocked(client.closeBrowserWorkspaceTab).mockResolvedValue({
      closed: true,
    });

    render(<BrowserWorkspaceView />);
    await waitFor(() =>
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(1),
    );

    const trigger = screen.getByRole("button", {
      name: "More browser actions",
    });
    const selectAction = async (name: string): Promise<void> => {
      await user.click(trigger);
      const item = await screen.findByRole("menuitem", { name });
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
      await user.click(item);
      await waitFor(() =>
        expect(trigger.getAttribute("aria-expanded")).toBe("false"),
      );
    };

    await selectAction("Refresh");
    await waitFor(() =>
      expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
        "tab-apple",
        "https://www.apple.com/",
      ),
    );

    await selectAction("Open external");
    await waitFor(() =>
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        "https://www.apple.com/",
      ),
    );

    await selectAction("Close all tabs");
    await waitFor(() =>
      expect(client.closeBrowserWorkspaceTab).toHaveBeenCalledWith("tab-apple"),
    );
    expect(await screen.findByText("No page open")).not.toBeNull();
  });

  it("returns focus to the folded tab control after the switcher closes", async () => {
    render(<BrowserWorkspaceView />);
    expect(await screen.findByText("No page open")).not.toBeNull();

    const trigger = screen.getByTestId("browser-workspace-tab-fold-control");
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByTestId("browser-workspace-tab-switcher");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
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

  it("keeps an explicit action refresh failure observable without leaking backend copy", async () => {
    vi.mocked(client.getBrowserWorkspace)
      .mockResolvedValueOnce(APPLE_WORKSPACE)
      .mockRejectedValueOnce(new Error("Explicit refresh failed"));
    vi.mocked(client.openBrowserWorkspaceTab).mockResolvedValue({
      tab: GOOGLE_WORKSPACE.tabs[0],
    });

    render(<BrowserWorkspaceView />);
    expect(await screen.findByTitle("Apple")).not.toBeNull();
    fireEvent.click(screen.getByTestId("browser-workspace-nav-new-tab"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Browser couldn’t connect. Try again in a moment.",
    );
    expect(alert.textContent).not.toContain("Explicit refresh failed");
  });

  it("keeps initial unavailability distinct from empty and exposes one recovery path", async () => {
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockRejectedValueOnce(new Error("Initial workspace load failed"))
      .mockResolvedValueOnce({ mode: "web", tabs: [] });

    render(<BrowserWorkspaceView />);
    const unavailable = await screen.findByText("Browser view unavailable");
    expect(screen.getByRole("alert").contains(unavailable)).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "Browser couldn’t connect. Try again in a moment.",
    );
    expect(screen.getByRole("alert").textContent).not.toContain(
      "Initial workspace load failed",
    );
    expect(screen.queryByText("No page open")).toBeNull();

    expect(screen.queryByTestId("browser-workspace-nav-new-tab")).toBeNull();
    expect(screen.queryByTestId("browser-workspace-address-input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Back to launcher" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No page open")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(2);
    const newTab = screen.getByTestId(
      "browser-workspace-nav-new-tab",
    ) as HTMLButtonElement;
    const address = screen.getByTestId(
      "browser-workspace-address-input",
    ) as HTMLInputElement;
    const go = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(newTab.disabled).toBe(false);
    expect(address.disabled).toBe(false);

    fireEvent.change(address, { target: { value: "example.com" } });
    expect(go.disabled).toBe(false);
  });

  it("does not offer Retry for the typed non-retryable Shared capability boundary", async () => {
    vi.mocked(client.getBrowserWorkspace).mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/browser-workspace",
        status: 503,
        code: "browser_workspace_runtime_unavailable",
        message:
          "Browser workspace requires a dedicated agent runtime; this shared agent does not run an isolated browser workspace.",
        data: {
          capability: "browser-workspace",
          requiredExecutionTier: "dedicated-always",
          retryable: false,
        },
      }),
    );

    render(<BrowserWorkspaceView />);

    expect(await screen.findByText("Browser view unavailable")).not.toBeNull();
    expect(
      screen.getByText("In-app browsing isn’t available with this connection."),
    ).not.toBeNull();
    expect(screen.queryByText(/requires a dedicated agent runtime/)).toBeNull();
    expect(screen.queryByText("No page open")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByTestId("browser-workspace-nav-new-tab")).toBeNull();
    expect(screen.queryByTestId("browser-workspace-address-input")).toBeNull();
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
    expect(screen.getByText("Opening Browser")).not.toBeNull();
    expect(screen.queryByText("No page open")).toBeNull();
    expect(screen.queryByTestId("browser-workspace-address-input")).toBeNull();

    await act(async () => {
      pendingInitialLoad.resolve(APPLE_WORKSPACE);
      await Promise.resolve();
    });
    expect(screen.getByTitle("Apple")).not.toBeNull();
    expect(screen.queryByText("Loading browser workspace")).toBeNull();
    expect(
      screen.getByTestId("browser-workspace-address-input"),
    ).not.toBeNull();
  });

  it("clears tabs immediately and ignores agent-A polling after a same-base profile switch", async () => {
    vi.useFakeTimers();
    const staleProfileRefresh = deferred<typeof APPLE_WORKSPACE>();
    const activeProfileLoad = deferred<typeof GOOGLE_WORKSPACE>();
    vi.mocked(client.getBrowserWorkspace)
      .mockReset()
      .mockResolvedValueOnce(APPLE_WORKSPACE)
      .mockReturnValueOnce(staleProfileRefresh.promise)
      .mockReturnValueOnce(activeProfileLoad.promise);

    try {
      const view = render(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTitle("Apple")).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(2);
      const staleSignal = vi.mocked(client.getBrowserWorkspace).mock
        .calls[1]?.[0]?.signal as AbortSignal;
      expect(staleSignal.aborted).toBe(false);

      authorityState.value = "profile-b\u0000https://same-agent.test";
      view.rerender(<BrowserWorkspaceView />);
      await act(async () => {
        await Promise.resolve();
      });

      expect(client.getBrowserWorkspace).toHaveBeenCalledTimes(3);
      expect(staleSignal.aborted).toBe(true);
      const activeSignal = vi.mocked(client.getBrowserWorkspace).mock
        .calls[2]?.[0]?.signal as AbortSignal;
      expect(activeSignal.aborted).toBe(false);
      expect(screen.queryByTitle("Apple")).toBeNull();
      expect(screen.getByText("Opening Browser")).not.toBeNull();

      await act(async () => {
        staleProfileRefresh.resolve(APPLE_WORKSPACE);
        await staleProfileRefresh.promise;
      });
      expect(screen.queryByTitle("Apple")).toBeNull();
      expect(screen.getByText("Opening Browser")).not.toBeNull();

      await act(async () => {
        activeProfileLoad.resolve(GOOGLE_WORKSPACE);
        await activeProfileLoad.promise;
      });
      expect(screen.getByTitle("Google")).not.toBeNull();
      expect(screen.queryByTitle("Apple")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts cloud-tab snapshot polling when the Browser lifecycle unmounts", async () => {
    const cloudWorkspace = {
      ...APPLE_WORKSPACE,
      mode: "cloud" as const,
    };
    vi.mocked(client.getBrowserWorkspace).mockResolvedValue(cloudWorkspace);
    vi.mocked(client.snapshotBrowserWorkspaceTab).mockImplementation(
      () => new Promise<{ data: string }>(() => undefined),
    );

    const view = render(<BrowserWorkspaceView />);
    await waitFor(() =>
      expect(client.snapshotBrowserWorkspaceTab).toHaveBeenCalledTimes(1),
    );
    const signal = vi.mocked(client.snapshotBrowserWorkspaceTab).mock
      .calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(signal.aborted).toBe(true);
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
