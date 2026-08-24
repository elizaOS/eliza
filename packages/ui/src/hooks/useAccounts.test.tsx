/**
 * Exercises account-list loading and every mutation through the real hook state
 * machine while the HTTP client remains the deterministic transport boundary.
 */
// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
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
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({ client }));
vi.mock("@elizaos/logger", () => ({
  logger: { warn: loggerWarn },
}));
vi.mock("../state/app-store", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (key, vars) => String(vars?.defaultValue ?? key) }),
}));
vi.mock("./useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));

import type { AccountsListResponse } from "../api/client-agent";
import { AccountCard } from "../components/accounts/AccountCard";
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

const initialProvider = initial.providers[0];
if (!initialProvider) throw new Error("Provider fixture is incomplete");
const primaryAccount = initialProvider.accounts[0];
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
  it("adopts a dialog-created account before the inventory refresh settles", async () => {
    let resolveRefresh: ((value: AccountsListResponse) => void) | undefined;
    const pendingRefresh = new Promise<AccountsListResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    client.listAccounts
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => pendingRefresh);
    const { result } = renderHook(() => useAccounts({ pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const created = {
      ...primaryAccount,
      id: "dialog-created",
      label: "Dialog created",
      priority: 1,
    };
    let refresh: Promise<void> | undefined;
    act(() => {
      refresh = result.current.refresh({
        providerId: "openai-api",
        account: created,
      });
    });

    await waitFor(() =>
      expect(result.current.data?.providers[0]?.accounts).toEqual([
        primaryAccount,
        { ...created, hasCredential: true },
      ]),
    );
    await act(async () => {
      resolveRefresh?.({
        providers: [
          {
            ...initialProvider,
            accounts: [primaryAccount, { ...created, hasCredential: true }],
          },
        ],
      });
      await refresh;
    });
  });

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

  it("reconciles a failed probe so the card immediately exposes reauthentication", async () => {
    const staleAccount = {
      ...primaryAccount,
      id: "codex-account",
      providerId: "openai-codex" as const,
      source: "oauth" as const,
      health: "rate-limited" as const,
    };
    const stale: AccountsListResponse = {
      providers: [
        {
          providerId: "openai-codex",
          strategy: "priority",
          accounts: [staleAccount],
        },
      ],
    };
    const staleProvider = stale.providers[0];
    if (!staleProvider) throw new Error("Stale account fixture is incomplete");
    const terminal: AccountsListResponse = {
      providers: [
        {
          ...staleProvider,
          accounts: [
            {
              ...staleAccount,
              health: "needs-reauth",
              healthDetail: {
                lastError: "Codex usage secondary window was invalid",
              },
            },
          ],
        },
      ],
    };
    let resolveStalePoll: ((value: AccountsListResponse) => void) | undefined;
    const stalePoll = new Promise<AccountsListResponse>((resolve) => {
      resolveStalePoll = resolve;
    });
    client.listAccounts
      .mockResolvedValueOnce(stale)
      .mockImplementationOnce(() => stalePoll)
      .mockResolvedValueOnce(terminal);
    client.refreshAccountUsage.mockRejectedValueOnce(
      new Error("Codex usage secondary window was invalid"),
    );
    const notices = vi.fn();

    function Harness() {
      const accounts = useAccounts({ pollMs: 0, setActionNotice: notices });
      const account = accounts.data?.providers[0]?.accounts[0];
      if (!account) return <div>loading</div>;
      return (
        <>
          <button type="button" onClick={() => void accounts.refresh()}>
            Poll
          </button>
          <AccountCard
            account={account}
            isFirst
            isLast
            saving={false}
            onPatch={vi.fn()}
            onMoveUp={vi.fn()}
            onMoveDown={vi.fn()}
            onTest={vi.fn()}
            onRefreshUsage={() =>
              accounts
                .refreshUsage("openai-codex", "codex-account")
                .catch(() => undefined)
            }
            onDelete={vi.fn()}
            onReauthenticate={vi.fn()}
          />
        </>
      );
    }

    render(<Harness />);
    await screen.findByText("Rate-limited");
    expect(screen.queryByRole("button", { name: "Reauthenticate" })).toBeNull();
    // Leave a stale regular list poll in flight while the probe fails.
    fireEvent.click(screen.getByRole("button", { name: "Poll" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await screen.findByText("Needs reauth");
    expect(screen.getByRole("button", { name: "Reauthenticate" })).toBeTruthy();
    await act(async () => resolveStalePoll?.(stale));
    expect(screen.getByText("Needs reauth")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reauthenticate" })).toBeTruthy();
    expect(notices).toHaveBeenCalledWith(
      "Failed to refresh usage: Codex usage secondary window was invalid",
      "error",
      6000,
    );
  });

  it("drops a rejected poll invalidated by a newer mutation instead of setting a stale error", async () => {
    let rejectStalePoll: ((err: Error) => void) | undefined;
    const stalePoll = new Promise<AccountsListResponse>((_resolve, reject) => {
      rejectStalePoll = reject;
    });
    client.listAccounts
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => stalePoll);
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Leave a poll in flight, invalidate it with a mutation, then fail it.
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.refresh();
    });
    await act(() =>
      result.current.patch("openai-api", "primary", { label: "Renamed" }),
    );
    await act(async () => {
      rejectStalePoll?.(new Error("transport down"));
      await pending;
    });

    expect(result.current.error).toBeNull();
    expect(notices).not.toHaveBeenCalledWith(
      "Failed to load accounts: transport down",
      "error",
      6000,
    );
  });

  it("reports reconciliation failure while preserving the primary probe rejection", async () => {
    const probeError = new Error("usage probe failed");
    const reconcileError = new Error("account list unavailable");
    client.listAccounts
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(reconcileError);
    client.refreshAccountUsage.mockRejectedValueOnce(probeError);
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(() => result.current.refreshUsage("openai-api", "primary")),
    ).rejects.toBe(probeError);

    expect(loggerWarn).toHaveBeenCalledWith(
      {
        error: reconcileError,
        providerId: "openai-api",
        accountId: "primary",
      },
      "[useAccounts] post-probe reconciliation failed",
    );
    expect(notices).toHaveBeenCalledWith(
      "Failed to refresh usage: usage probe failed",
      "error",
      6000,
    );
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

  it("rolls back an optimistic rename when the server rejects the patch", async () => {
    client.patchAccount.mockRejectedValueOnce(new Error("write conflict"));
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(() =>
        result.current.patch("openai-api", "primary", { label: "Renamed" }),
      ),
    ).rejects.toThrow("write conflict");

    expect(
      result.current.data?.providers[0]?.accounts.find(
        (account) => account.id === "primary",
      )?.label,
    ).toBe("Primary");
    expect(result.current.saving.has("primary")).toBe(false);
    expect(notices).toHaveBeenCalledWith(
      "Failed to update account: write conflict",
      "error",
      6000,
    );
  });

  it("keeps an account listed when its deletion fails", async () => {
    client.deleteAccount.mockRejectedValueOnce(new Error("still referenced"));
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(() => result.current.remove("openai-api", "primary")),
    ).rejects.toThrow("still referenced");

    expect(
      result.current.data?.providers[0]?.accounts.some(
        (account) => account.id === "primary",
      ),
    ).toBe(true);
    expect(result.current.saving.has("primary")).toBe(false);
    expect(notices).toHaveBeenCalledWith(
      "Failed to delete account: still referenced",
      "error",
      6000,
    );
  });

  it("reports a failed creation without adding the account or leaking the saving flag", async () => {
    let rejectCreate: ((err: Error) => void) | undefined;
    client.createApiKeyAccount.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.createApiKey("openai-api", {
        label: "Secondary",
        apiKey: "test-key-value",
      });
    });
    expect(result.current.saving.has("create:openai-api")).toBe(true);

    await act(async () => {
      rejectCreate?.(new Error("duplicate label"));
      await pending?.catch(() => undefined);
    });

    expect(
      result.current.data?.providers[0]?.accounts.some(
        (account) => account.id === "secondary",
      ),
    ).toBe(false);
    expect(result.current.saving.size).toBe(0);
    expect(notices).toHaveBeenCalledWith(
      "Failed to create account: duplicate label",
      "error",
      6000,
    );
  });

  it("surfaces a failed probe through the action notice channel", async () => {
    client.testAccount
      .mockResolvedValueOnce({ ok: false, error: "invalid key" })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(await result.current.test("openai-api", "primary")).toEqual({
        ok: false,
        error: "invalid key",
      });
    });
    expect(notices).toHaveBeenCalledWith(
      "Connection failed: invalid key",
      "error",
      6000,
    );

    await act(async () => {
      expect(await result.current.test("openai-api", "primary")).toEqual({
        ok: false,
        status: 503,
      });
    });
    expect(notices).toHaveBeenLastCalledWith(
      "Connection failed: HTTP 503",
      "error",
      6000,
    );
  });

  it("appends measured latency to a successful probe notice", async () => {
    client.testAccount.mockResolvedValueOnce({
      ok: true,
      message: "ok",
      latencyMs: 123,
    });
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.test("openai-api", "primary");
    });
    expect(notices).toHaveBeenCalledWith(
      "Connection OK (123ms)",
      "success",
      3000,
    );
  });

  it("falls back to the bare prefix when a load fails without an Error", async () => {
    client.listAccounts.mockRejectedValueOnce("hard down");
    const notices = vi.fn();
    const { result } = renderHook(() =>
      useAccounts({ pollMs: 0, setActionNotice: notices }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("Failed to load accounts");
    expect(notices).toHaveBeenCalledWith(
      "Failed to load accounts",
      "error",
      6000,
    );
  });

  it("shows a rotation-strategy change optimistically before the server confirms", async () => {
    let resolveStrategy: (() => void) | undefined;
    client.patchProviderStrategy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStrategy = resolve;
        }),
    );
    const { result } = renderHook(() => useAccounts({ pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.setStrategy("openai-api", "reset-soonest");
    });
    expect(result.current.data?.providers[0]?.strategy).toBe("reset-soonest");

    await act(async () => {
      resolveStrategy?.();
      await pending;
    });
    expect(result.current.data?.providers[0]?.strategy).toBe("reset-soonest");
    expect(result.current.saving.has("strategy:openai-api")).toBe(false);
  });

  it("restores the previous rotation strategy when the save fails", async () => {
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

    expect(result.current.data?.providers[0]?.strategy).toBe("priority");
    expect(result.current.saving.has("strategy:openai-api")).toBe(false);
    expect(notices).toHaveBeenCalledWith(
      "Failed to update rotation strategy: config write failed",
      "error",
      6000,
    );
  });

  it("scopes a mutation to the requested provider without disturbing siblings", async () => {
    const codexAccount = {
      ...primaryAccount,
      id: "codex-account",
      providerId: "openai-codex" as const,
      source: "oauth" as const,
      priority: 1,
    };
    const twoProviders: AccountsListResponse = {
      providers: [
        { ...initialProvider },
        {
          providerId: "openai-codex",
          strategy: "priority",
          accounts: [codexAccount],
        },
      ],
    };
    client.listAccounts.mockResolvedValueOnce(twoProviders);
    client.patchAccount.mockResolvedValueOnce({
      ...codexAccount,
      label: "Codex Renamed",
    });
    const { result } = renderHook(() => useAccounts({ pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() =>
      result.current.patch("openai-codex", "codex-account", {
        label: "Codex Renamed",
      }),
    );

    expect(client.patchAccount).toHaveBeenCalledWith(
      "openai-codex",
      "codex-account",
      { label: "Codex Renamed" },
    );
    expect(result.current.data?.providers.length).toBe(2);
    expect(result.current.data?.providers[0]?.accounts[0]?.label).toBe(
      "Primary",
    );
    expect(result.current.data?.providers[1]?.accounts[0]?.label).toBe(
      "Codex Renamed",
    );
  });
});
