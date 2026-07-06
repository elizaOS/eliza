// @vitest-environment jsdom
//
// BuildBadge — renders the label from /build-info.json, hides on tap for
// the rest of the session, and stays silently hidden when the stamp is absent.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildBadge } from "./BuildBadge";

const BUILD_INFO = {
  commit: "58f6bb3beb",
  builtAt: "2026-07-03 17:42 MDT",
  label: "58f6bb3beb · Jul 03 17:42 MDT",
};

function mockFetchOk(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

describe("BuildBadge", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the build label from /build-info.json", async () => {
    mockFetchOk(BUILD_INFO);
    render(<BuildBadge />);
    const badge = await screen.findByTestId("build-badge");
    expect(badge.textContent).toContain("58f6bb3beb · Jul 03 17:42 MDT");
    const anchor = badge.closest("[data-aesthetic-overlay-ignore='true']");
    expect(anchor).not.toBeNull();
    expect((anchor as HTMLElement).style.paddingBottom).toContain(
      "--eliza-continuous-chat-clearance",
    );
    expect(fetch).toHaveBeenCalledWith(
      "/build-info.json",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reserves the floating chat clearance above the bottom edge", async () => {
    mockFetchOk(BUILD_INFO);
    render(<BuildBadge />);
    await screen.findByTestId("build-badge");
    const anchor = screen.getByTestId("build-badge-anchor");
    expect(anchor.getAttribute("style")).toContain(
      "--eliza-continuous-chat-clearance",
    );
  });

  it("falls back to commit + builtAt when label is missing", async () => {
    mockFetchOk({ commit: "58f6bb3beb", builtAt: "2026-07-03 17:42 MDT" });
    render(<BuildBadge />);
    const badge = await screen.findByTestId("build-badge");
    expect(badge.textContent).toContain("58f6bb3 · 2026-07-03 17:42 MDT");
  });

  it("dismisses on tap and persists for the session", async () => {
    mockFetchOk(BUILD_INFO);
    const user = userEvent.setup();
    render(<BuildBadge />);
    await screen.findByTestId("build-badge");
    // The X button dismisses (the label button now opens diagnostics instead).
    await user.click(screen.getByTestId("build-badge-dismiss"));
    expect(screen.queryByTestId("build-badge")).toBeNull();
    expect(window.sessionStorage.getItem("eliza.buildBadge.dismissed")).toBe(
      "1",
    );

    // Remount within the same session — stays hidden without refetching.
    cleanup();
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    render(<BuildBadge />);
    expect(screen.queryByTestId("build-badge")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the on-device diagnostics overlay on badge tap", async () => {
    mockFetchOk(BUILD_INFO);
    const user = userEvent.setup();
    render(<BuildBadge />);
    const badge = await screen.findByTestId("build-badge");
    expect(screen.queryByTestId("build-badge-diag")).toBeNull();
    await user.click(badge);
    const diag = await screen.findByTestId("build-badge-diag");
    // The overlay must surface the ground-truth rows that decide the PWA
    // lockdown so a screenshot ends the blind-fix loop.
    expect(diag.textContent).toContain("pwa-standalone");
    expect(diag.textContent).toContain("display-mode");
    expect(diag.textContent).toContain("100lvh");
    expect(diag.textContent).toContain("safe-inset-bottom");
    // Tapping the badge does NOT dismiss it.
    expect(screen.queryByTestId("build-badge")).not.toBeNull();
    // Close via the overlay's own close button.
    await user.click(screen.getByTestId("build-badge-diag-close"));
    expect(screen.queryByTestId("build-badge-diag")).toBeNull();
    // Badge is still present after closing diagnostics.
    expect(screen.queryByTestId("build-badge")).not.toBeNull();
  });

  it("(d) renders the live geometry probe line ON the badge (no tap needed)", async () => {
    mockFetchOk(BUILD_INFO);
    render(<BuildBadge />);
    // The badge must render first (stamped build), which gates the geometry line.
    await screen.findByTestId("build-badge");
    const geom = await screen.findByTestId("build-badge-geom");
    // Compact single line with every probed geometry value so the NEXT device
    // screenshot reveals the exact viewport numbers — innerHeight (ih),
    // visualViewport (vv), documentElement.clientHeight (ce), screen.height
    // (sh), the measured reclaim var (rc), and the 100lvh/100dvh offsetHeight
    // probes (lv/dv). jsdom returns 0 for these, but the KEYS must all be
    // present and correctly formatted.
    for (const key of ["ih", "vv", "ce", "sh", "rc", "lv", "dv"]) {
      expect(geom.textContent).toMatch(new RegExp(`${key}[0-9?]`));
    }
  });

  it("(d) surfaces the lvh/dvh offset probes + reclaim var in the diagnostics overlay", async () => {
    mockFetchOk(BUILD_INFO);
    const user = userEvent.setup();
    render(<BuildBadge />);
    const badge = await screen.findByTestId("build-badge");
    await user.click(badge);
    const diag = await screen.findByTestId("build-badge-diag");
    // The offsetHeight-based 100lvh/100dvh probes and the live reclaim var are
    // the numbers that test the measurement-failure hypothesis on device.
    expect(diag.textContent).toContain("100lvh(offset)");
    expect(diag.textContent).toContain("100dvh(offset)");
    expect(diag.textContent).toContain("reclaim-var");
    expect(diag.textContent).toContain("docEl.clientH");
    expect(diag.textContent).toContain("screen.height");
  });

  it("renders nothing when build info is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    render(<BuildBadge />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("build-badge")).toBeNull();
  });
});
