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
vi.mock("../state", () => ({
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
});
