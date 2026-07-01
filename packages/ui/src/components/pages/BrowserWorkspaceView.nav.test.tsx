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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceSnapshot, BrowserWorkspaceTab } from "../../api";
import { client } from "../../api";
import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

// ─────────────────────────────────────────────────────────────────────────
// Seam map (what is real vs. mocked)
//
// The view drives ALL browser I/O through the `client` singleton re-exported
// from `../../api` — the single real data seam. We spy on the concrete methods
// on the real instance so every other `../../api` runtime export (used deep in
// the layout/sidebar tree) keeps working. The app store is consumed only via
// `useAppSelectorShallow`; we override just that hook (keeping the rest of
// `../../state` real) and feed a controllable snapshot, exactly like the other
// page-view tests. Everything else in the render tree (WorkspaceLayout,
// AppWorkspaceChrome, sidebar composites, useAgentElement, the wallet bridge)
// runs for real — they are the unit's collaborators-by-composition, not the
// seam under test.
//
// NOTE ON "back/forward": this component intentionally has NO back/forward
// history controls — navigation is URL-driven (address bar Enter / Go), plus a
// reload button whose web-mode implementation only re-assigns `iframe.src`
// (no observable client seam). So this file covers the real navigation
// surface: URL entry, tab open/close/switch, new-tab seeding, and the empty
// state. Reload/back/forward are documented as out-of-surface below.
// ─────────────────────────────────────────────────────────────────────────

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state")>();
  return {
    ...actual,
    useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
      sel(appMock.value),
  };
});

function t(
  key: string,
  options?: { defaultValue?: string } & Record<string, unknown>,
): string {
  let out = options?.defaultValue ?? key;
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (k === "defaultValue") continue;
      out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v));
    }
  }
  return out;
}

const setActionNotice = vi.fn();

function makeTab(overrides: Partial<BrowserWorkspaceTab> = {}): BrowserWorkspaceTab {
  return {
    id: "tab-1",
    title: "Example",
    url: "https://example.com/",
    partition: "",
    kind: "standard",
    visible: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastFocusedAt: null,
    ...overrides,
  };
}

// Mutable snapshot the getBrowserWorkspace spy reads on every (mount + poll +
// post-mutation) refetch, so we can model server state transitions.
let snapshot: BrowserWorkspaceSnapshot;

function configureClient(): void {
  vi.spyOn(client, "getBrowserWorkspace").mockImplementation(async () => snapshot);
  vi.spyOn(client, "getWalletConfig").mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof client.getWalletConfig>>,
  );
  vi.spyOn(client, "snapshotBrowserWorkspaceTab").mockResolvedValue({
    data: "",
  } as Awaited<ReturnType<typeof client.snapshotBrowserWorkspaceTab>>);
  vi.spyOn(client, "openBrowserWorkspaceTab").mockImplementation(
    async (req) => ({ tab: makeTab({ id: "tab-new", url: req.url ?? "" }) }),
  );
  vi.spyOn(client, "showBrowserWorkspaceTab").mockImplementation(
    async (id) => ({
      tab: snapshot.tabs.find((tab) => tab.id === id) ?? makeTab({ id }),
    }),
  );
  vi.spyOn(client, "navigateBrowserWorkspaceTab").mockImplementation(
    async (id, url) => ({
      tab: makeTab({
        ...(snapshot.tabs.find((tab) => tab.id === id) ?? makeTab({ id })),
        id,
        url,
      }),
    }),
  );
  vi.spyOn(client, "closeBrowserWorkspaceTab").mockResolvedValue({
    closed: true,
  });
}

beforeEach(() => {
  appMock.value = {
    t,
    plugins: [],
    uiTheme: "dark",
    walletAddresses: null,
    walletConfig: { available: false } as unknown,
    getStewardStatus: async () => ({
      available: false,
      configured: false,
      connected: false,
    }),
    getStewardPending: async () => [],
    setActionNotice,
  };
  snapshot = { mode: "web", tabs: [makeTab()] };
  configureClient();

  // jsdom lacks matchMedia; the layout tree probes it (guarded) — provide a
  // desktop-viewport stub so both branches resolve deterministically.
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setActionNotice.mockReset();
});

function addressInput(): HTMLInputElement {
  return screen.getByTestId("browser-workspace-address-input") as HTMLInputElement;
}

async function renderView(): Promise<void> {
  render(<BrowserWorkspaceView />);
  // Initial load resolves the snapshot + selects the visible tab.
  await waitFor(() =>
    expect(client.getBrowserWorkspace).toHaveBeenCalled(),
  );
}

describe("BrowserWorkspaceView — navigation & tabs", () => {
  it("normalizes a bare host typed in the address bar and navigates the active tab (Enter)", async () => {
    await renderView();
    // Address bar mirrors the selected tab's URL once loaded.
    await waitFor(() =>
      expect(addressInput().value).toBe("https://example.com/"),
    );

    fireEvent.change(addressInput(), { target: { value: "docs.example.org" } });
    fireEvent.keyDown(addressInput(), { key: "Enter" });

    await waitFor(() =>
      expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledTimes(1),
    );
    // Exact semantic outcome: scheme-less host is upgraded to https + path.
    expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
      "tab-1",
      "https://docs.example.org/",
    );
    expect(client.openBrowserWorkspaceTab).not.toHaveBeenCalled();
  });

  it("navigates via the Go button with the same normalized payload", async () => {
    await renderView();
    await waitFor(() =>
      expect(addressInput().value).toBe("https://example.com/"),
    );

    fireEvent.change(addressInput(), { target: { value: "https://a.test/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() =>
      expect(client.navigateBrowserWorkspaceTab).toHaveBeenCalledWith(
        "tab-1",
        "https://a.test/x",
      ),
    );
  });

  it("opens a new tab (instead of navigating) when no tab is selected", async () => {
    snapshot = { mode: "web", tabs: [] };
    await renderView();
    // Empty workspace → empty state, no iframe, no selected tab.
    await waitFor(() =>
      expect(screen.getByText("Open a website")).toBeTruthy(),
    );

    fireEvent.change(addressInput(), { target: { value: "example.net" } });
    fireEvent.keyDown(addressInput(), { key: "Enter" });

    await waitFor(() =>
      expect(client.openBrowserWorkspaceTab).toHaveBeenCalledTimes(1),
    );
    expect(client.openBrowserWorkspaceTab).toHaveBeenCalledWith({
      url: "https://example.net/",
      title: "example.net",
      partition: undefined,
      show: true,
    });
    expect(client.navigateBrowserWorkspaceTab).not.toHaveBeenCalled();
  });

  it("rejects an unsupported-protocol URL with an error notice and no navigation", async () => {
    await renderView();
    await waitFor(() =>
      expect(addressInput().value).toBe("https://example.com/"),
    );

    fireEvent.change(addressInput(), { target: { value: "ftp://malware.zip" } });
    fireEvent.keyDown(addressInput(), { key: "Enter" });

    await waitFor(() => expect(setActionNotice).toHaveBeenCalled());
    const [message, level] = setActionNotice.mock.calls[0];
    expect(String(message)).toMatch(/http and https/i);
    expect(level).toBe("error");
    expect(client.navigateBrowserWorkspaceTab).not.toHaveBeenCalled();
  });

  it("switches the active tab and marks the clicked tab selected", async () => {
    snapshot = {
      mode: "web",
      tabs: [
        makeTab({ id: "tab-1", title: "First", visible: true }),
        makeTab({
          id: "tab-2",
          title: "Second",
          url: "https://second.test/",
          visible: false,
        }),
      ],
    };
    await renderView();

    const tabs = () => screen.getAllByRole("tab");
    await waitFor(() => expect(tabs()).toHaveLength(2));
    // Initial selection = the visible tab (tab-1).
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs()[1].getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: /Second/ }));

    await waitFor(() =>
      expect(client.showBrowserWorkspaceTab).toHaveBeenCalledWith("tab-2"),
    );
    // Selection state flips optimistically to the clicked tab.
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: /Second/ }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(
      screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("closes a tab through the client and drops it from the list", async () => {
    snapshot = {
      mode: "web",
      tabs: [
        makeTab({ id: "tab-1", title: "First", visible: true }),
        makeTab({
          id: "tab-2",
          title: "Second",
          url: "https://second.test/",
          visible: false,
        }),
      ],
    };
    // Model the server dropping tab-2 the moment it is closed.
    (client.closeBrowserWorkspaceTab as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        snapshot = { mode: "web", tabs: [snapshot.tabs[0]] };
        return { closed: true };
      },
    );
    await renderView();
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    const secondRow = screen.getByRole("tab", { name: /Second/ })
      .parentElement as HTMLElement;
    fireEvent.click(
      within(secondRow).getByRole("button", { name: /Close tab Second/i }),
    );

    await waitFor(() =>
      expect(client.closeBrowserWorkspaceTab).toHaveBeenCalledWith("tab-2"),
    );
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.queryByRole("tab", { name: /Second/ })).toBeNull();
  });

  it("seeds a fresh tab with the docs home URL from the empty state", async () => {
    snapshot = { mode: "web", tabs: [] };
    await renderView();
    await waitFor(() => expect(screen.getByText("Open a website")).toBeTruthy());

    fireEvent.click(screen.getByTestId("browser-workspace-nav-new-tab"));

    await waitFor(() =>
      expect(client.openBrowserWorkspaceTab).toHaveBeenCalledTimes(1),
    );
    expect(client.openBrowserWorkspaceTab).toHaveBeenCalledWith({
      url: "https://docs.elizaos.ai/",
      title: "docs.elizaos.ai",
      partition: undefined,
      show: true,
    });
  });

  it("is idempotent under a double-click while the open is in flight", async () => {
    snapshot = { mode: "web", tabs: [] };
    // Hold the open pending so busyAction stays set and re-gates the button.
    let release!: () => void;
    (client.openBrowserWorkspaceTab as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ tab: makeTab({ id: "tab-new" }) });
        }),
    );
    await renderView();
    await waitFor(() => expect(screen.getByText("Open a website")).toBeTruthy());

    const newTabBtn = screen.getByTestId(
      "browser-workspace-nav-new-tab",
    ) as HTMLButtonElement;
    fireEvent.click(newTabBtn);
    // First click flips busyAction → the button disables itself.
    await waitFor(() => expect(newTabBtn.disabled).toBe(true));
    // Second click on the now-disabled control must be a no-op.
    fireEvent.click(newTabBtn);

    expect(client.openBrowserWorkspaceTab).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
  });

  it("renders the populated web surface as an iframe pointed at the tab URL", async () => {
    await renderView();
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe");
      if (!el) throw new Error("iframe not yet rendered");
      return el as HTMLIFrameElement;
    });
    expect(frame.getAttribute("src")).toBe("https://example.com/");
    // Not the empty state.
    expect(screen.queryByText("Open a website")).toBeNull();
  });
});
