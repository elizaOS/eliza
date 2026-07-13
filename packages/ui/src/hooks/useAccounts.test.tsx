/**
 * Exercises account-list loading and every mutation through the real hook state
 * machine while the HTTP client remains the deterministic transport boundary.
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  createApiKeyAccount: vi.fn(),
  patchAccount: vi.fn(),
  deleteAccount: vi.fn(),
  testAccount: vi.fn(),
  refreshAccountUsage: vi.fn(),
  patchProviderStrategy: vi.fn(),
}));

vi.mock("../api", () => ({ client }));
vi.mock("./useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));

import type { AccountsListResponse } from "../api/client-agent";
import { useAccounts } from "./useAccounts";

const initial: AccountsListResponse = {
  providers: [
    {
      providerId: "openai-api",
      strategy: "priority",
      accounts: [
        {
          id: "primary",
          providerId: "openai-api",
          label: "Primary",
          source: "api-key",
          enabled: true,
          priority: 0,
          createdAt: 1,
          health: "ok",
          hasCredential: true,
        },
      ],
    },
  ],
};

const primaryAccount = initial.providers[0]?.accounts[0];
if (!primaryAccount) throw new Error("Account fixture is incomplete");

beforeEach(() => {
  vi.clearAllMocks();
  client.listAccounts.mockResolvedValue(initial);
  client.createApiKeyAccount.mockResolvedValue({
    ...primaryAccount,
    id: "secondary",
    label: "Secondary",
    priority: 1,
  });
  client.patchAccount.mockResolvedValue({
    ...primaryAccount,
    label: "Renamed",
  });
  client.deleteAccount.mockResolvedValue(undefined);
  client.testAccount.mockResolvedValue({ ok: true, message: "ok" });
  client.refreshAccountUsage.mockResolvedValue({
    account: primaryAccount,
  });
  client.patchProviderStrategy.mockResolvedValue({
    providerId: "openai-api",
    strategy: "reset-soonest",
  });
});

describe("useAccounts", () => {
  it("loads, mutates, and reconciles account state", async () => {
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();

    await act(() =>
      result.current.createApiKey("openai-api", {
        label: "Secondary",
        apiKey: "test-key-value",
      }),
    );
    await act(() =>
      result.current.patch("openai-api", "primary", { label: "Renamed" }),
    );
    await act(() => result.current.refreshUsage("openai-api", "primary"));
    await act(() => result.current.setStrategy("openai-api", "reset-soonest"));
    await act(async () => {
      expect(await result.current.test("openai-api", "primary")).toEqual({
        ok: true,
        message: "ok",
      });
    });
    await act(() => result.current.remove("openai-api", "secondary"));

    expect(client.listAccounts.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.saving.size).toBe(0);
    expect(notices).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("keeps load failures distinct from a healthy empty response", async () => {
    client.listAccounts.mockRejectedValueOnce(new Error("transport down"));
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe(
      "Failed to load accounts: transport down",
    );
    expect(notices).toHaveBeenCalled();
  });

  it("surfaces a rejected strategy save before rethrowing it", async () => {
    client.patchProviderStrategy.mockRejectedValueOnce(
      new Error("config write failed"),
    );
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(() => result.current.setStrategy("openai-api", "reset-soonest")),
    ).rejects.toThrow("config write failed");
    expect(notices).toHaveBeenCalledWith(
      "Failed to update rotation strategy: config write failed",
      "error",
      6000,
    );
  });
});
