/** Verifies AppsSection kebab hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPS_CREATE_EDIT_FETCH_TIMEOUT_MS,
  APPS_RELAUNCH_FETCH_TIMEOUT_MS,
  relaunchAppViaClient,
  startAppEditViaClient,
} from "./AppsSection";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

describe("AppsSection native-complete deadlines", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps a documented budget per hop", () => {
    expect(APPS_RELAUNCH_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(APPS_CREATE_EDIT_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes relaunch timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(
      relaunchAppViaClient({ fetch: fetchMock }, "demo"),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apps/relaunch",
      {
        method: "POST",
        body: JSON.stringify({ name: "demo" }),
      },
      { timeoutMs: APPS_RELAUNCH_FETCH_TIMEOUT_MS },
    );
  });

  it("passes create/edit timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(
      startAppEditViaClient({ fetch: fetchMock }, "demo"),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apps/create",
      {
        method: "POST",
        body: JSON.stringify({ intent: "edit", editTarget: "demo" }),
      },
      { timeoutMs: APPS_CREATE_EDIT_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled relaunch hop as TimeoutError", async () => {
    const timeout = Object.assign(new Error("Request timed out after 10ms"), {
      name: "ApiError",
      kind: "timeout",
    });
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeout), 10);
        }),
    );
    await expect(
      relaunchAppViaClient({ fetch: fetchMock }, "demo", 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed create/edit POST", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("Apps create failed (503)"), {
        name: "ApiError",
        kind: "http",
        status: 503,
      }),
    );
    await expect(
      startAppEditViaClient({ fetch: fetchMock }, "demo"),
    ).rejects.toMatchObject({ status: 503 });
  });
});
