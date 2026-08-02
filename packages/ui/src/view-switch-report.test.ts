/**
 * Active-view convergence tests use real Request/Response objects around a
 * deterministic transport seam so HTTP contracts and race-safe behavior stay
 * covered without booting the full app shell.
 */

import { describe, expect, it, vi } from "vitest";
import { synchronizeUserViewSwitch } from "./view-switch-report";

const BASE = "http://127.0.0.1:31337";

function currentViewResponse(
  currentView: { viewId: string; viewPath: string | null } | null,
): Response {
  return new Response(JSON.stringify({ currentView, justSwitched: false }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("synchronizeUserViewSwitch", () => {
  it("preserves an already-matching agent-owned current view", async () => {
    const fetchFn = vi.fn(async () =>
      currentViewResponse({ viewId: "notes", viewPath: "/notes" }),
    );

    await expect(
      synchronizeUserViewSwitch("notes", "/notes", {
        apiBase: BASE,
        fetchFn,
      }),
    ).resolves.toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      `${BASE}/api/views/current`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("restores a visible deep link when the runtime lost current-view state", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(currentViewResponse(null))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      synchronizeUserViewSwitch("notes", "/notes", {
        apiBase: BASE,
        apiToken: "token",
        fetchFn,
      }),
    ).resolves.toBe(true);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      `${BASE}/api/views/notes/navigate`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
        body: JSON.stringify({ source: "user", path: "/notes" }),
      }),
    );
  });

  it("reports browser history when it differs from server state", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        currentViewResponse({ viewId: "chat", viewPath: "/chat" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      synchronizeUserViewSwitch("simple-calendar", "/simple-calendar", {
        apiBase: BASE,
        fetchFn,
      }),
    ).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed current-view responses", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ currentView: {} }), { status: 200 }),
    );

    await expect(
      synchronizeUserViewSwitch("notes", "/notes", {
        apiBase: BASE,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: "CURRENT_VIEW_SYNC_RESPONSE_INVALID" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("skips runtimes that intentionally do not serve app-shell routes", async () => {
    const fetchFn = vi.fn();

    await expect(
      synchronizeUserViewSwitch("notes", "/notes", {
        apiBase: "https://37911a1e-ed40-4626-88f5.elizacloud.ai",
        fetchFn,
      }),
    ).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
