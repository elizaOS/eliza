// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import { useCloudState } from "../useCloudState";

const SESSION_ID = "bbbbbbbb-2222-4333-8444-cccccccccccc";
const RETURN_URL = `/chat?elizaCloudLogin=complete&elizaCloudLoginSession=${SESSION_ID}`;
const PENDING_KEY = `eliza-cloud-login-pending:${SESSION_ID}`;
const params = {
  setActionNotice: vi.fn(),
  loadWalletConfig: vi.fn(async () => {}),
  t: (key: string) => key,
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", RETURN_URL);
  vi.spyOn(client, "getCloudStatus").mockResolvedValue({
    connected: false,
    enabled: false,
  } as Awaited<ReturnType<typeof client.getCloudStatus>>);
  vi.spyOn(client, "getCloudCredits").mockResolvedValue({
    connected: false,
  } as Awaited<ReturnType<typeof client.getCloudCredits>>);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("Cloud login return", () => {
  it("strips a returned session this browser did not start and never claims it", async () => {
    const poll = vi.spyOn(client, "cloudLoginPollDirect");
    renderHook(() => useCloudState(params));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/chat");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(poll).not.toHaveBeenCalled();
    expect(localStorage.getItem("steward_session_token")).toBeNull();
  });

  it("ignores an expired pending entry for the returned session", async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ verifier: "v", expiresAt: Date.now() - 1 }),
    );
    const poll = vi.spyOn(client, "cloudLoginPollDirect");
    renderHook(() => useCloudState(params));
    await waitFor(() => expect(window.location.search).toBe(""));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(poll).not.toHaveBeenCalled();
  });

  it("claims a returned session this browser started", async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ verifier: "v", expiresAt: Date.now() + 60_000 }),
    );
    const poll = vi
      .spyOn(client, "cloudLoginPollDirect")
      .mockResolvedValue({ status: "expired", error: "expired" });
    renderHook(() => useCloudState(params));
    await waitFor(() =>
      expect(poll).toHaveBeenCalledWith(expect.any(String), SESSION_ID),
    );
    expect(window.location.search).toBe("");
  });
});
