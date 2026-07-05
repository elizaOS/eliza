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
    expect(fetch).toHaveBeenCalledWith(
      "/build-info.json",
      expect.objectContaining({ cache: "no-store" }),
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
    const badge = await screen.findByTestId("build-badge");
    await user.click(badge);
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
