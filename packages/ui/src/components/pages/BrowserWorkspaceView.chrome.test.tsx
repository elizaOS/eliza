/**
 * Verifies the Browser view's fullscreen chrome contract: with the builtin
 * registry declaring `header: "fullscreen"`, the view owns its whole surface —
 * no shared ViewHeader row, a floating glass toolbar, and the workspace root
 * as a `<main>` landmark. Renders the real component in jsdom with the API
 * client mocked (deterministic empty workspace).
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      getBrowserWorkspace: vi
        .fn()
        .mockResolvedValue({ mode: "embedded", tabs: [] }),
      snapshotBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
    },
  };
});

import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

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
    expect(toolbar.className).toContain("rounded-[22px]");
    // The address bar lives inside the floating toolbar, not a page header.
    expect(
      toolbar.contains(screen.getByTestId("browser-workspace-address-input")),
    ).toBe(true);
  });
});
