/**
 * Focused AccountList coverage: credential-repair dialog wiring (repair state
 * set on reauthenticate, cleared on plain add and on close), priority-swap
 * move semantics with rollback, and the persisted-OAuth dialog restore.
 */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountList } from "./AccountList";
import { readSubscriptionOAuth } from "./subscription-oauth-state";

const accounts = vi.hoisted(() => ({
  data: {
    providers: [
      {
        providerId: "openai-api",
        strategy: "priority",
        accounts: [
          {
            id: "second",
            label: "Second",
            priority: 2,
            enabled: true,
            health: "needs-reauth",
          },
          {
            id: "first",
            label: "First",
            priority: 1,
            enabled: true,
            health: "ok",
          },
        ],
      },
    ],
  },
  loading: false,
  error: null as string | null,
  patch: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
  refreshUsage: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  saving: new Set<string>(),
  setStrategy: vi.fn().mockResolvedValue(undefined),
  test: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../hooks/useAccounts", () => ({ useAccounts: () => accounts }));
vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (key, vars) => String(vars?.defaultValue ?? key) }),
}));
vi.mock("./subscription-oauth-state", () => ({
  readSubscriptionOAuth: vi.fn(() => null),
}));
vi.mock("./RotationStrategyPicker", () => ({
  RotationStrategyPicker: ({
    onChange,
  }: {
    onChange: (value: string) => void;
  }) => (
    <button type="button" onClick={() => onChange("round-robin")}>
      change strategy
    </button>
  ),
}));
vi.mock("./AccountCard", () => ({
  AccountCard: ({
    account,
    onMoveUp,
    onMoveDown,
    onTest,
    onRefreshUsage,
    onDelete,
    onReauthenticate,
  }: {
    account: { label: string };
    onMoveUp: () => Promise<void>;
    onMoveDown: () => Promise<void>;
    onTest: () => Promise<void>;
    onRefreshUsage: () => Promise<void>;
    onDelete: () => Promise<void>;
    onReauthenticate: () => void;
  }) => (
    <div>
      <span>card {account.label}</span>
      <button
        type="button"
        onClick={() => {
          void onMoveUp().catch(() => {});
        }}
      >
        up {account.label}
      </button>
      <button
        type="button"
        onClick={() => {
          void onMoveDown().catch(() => {});
        }}
      >
        down {account.label}
      </button>
      <button
        type="button"
        onClick={() => {
          void onTest();
        }}
      >
        test {account.label}
      </button>
      <button
        type="button"
        onClick={() => {
          void onRefreshUsage();
        }}
      >
        refresh {account.label}
      </button>
      <button
        type="button"
        onClick={() => {
          void onDelete();
        }}
      >
        delete {account.label}
      </button>
      <button type="button" onClick={onReauthenticate}>
        reauthenticate {account.label}
      </button>
    </div>
  ),
}));
vi.mock("./AddAccountDialog", () => ({
  AddAccountDialog: ({
    open,
    credentialRepairAccount,
    onClose,
    onCreated,
  }: {
    open: boolean;
    credentialRepairAccount?: { id: string } | null;
    onClose: () => void;
    onCreated: (account: {
      id: string;
      providerId: "openai-api";
      label: string;
      source: "api-key";
      enabled: boolean;
      priority: number;
      createdAt: number;
      health: "ok";
    }) => void;
  }) =>
    open ? (
      <div role="dialog">
        add dialog {credentialRepairAccount?.id ?? "new"}
        <button
          type="button"
          onClick={() =>
            onCreated({
              id: "created",
              providerId: "openai-api",
              label: "Created",
              source: "api-key",
              enabled: true,
              priority: 3,
              createdAt: 1,
              health: "ok",
            })
          }
        >
          finish add
        </button>
        <button type="button" onClick={onClose}>
          close dialog
        </button>
      </div>
    ) : null,
}));

const mockedReadSubscriptionOAuth = vi.mocked(readSubscriptionOAuth);

describe("AccountList", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockedReadSubscriptionOAuth.mockReturnValue(null);
    accounts.loading = false;
    accounts.error = null;
    accounts.patch.mockResolvedValue(undefined);
  });

  it("shows the loading indicator before the first account list arrives", () => {
    accounts.loading = true;
    const data = accounts.data;
    // biome-ignore lint/suspicious/noExplicitAny: test toggles the hook's data shape
    (accounts as any).data = null;
    render(<AccountList providerId="openai-api" />);
    expect(screen.getByText("Loading accounts…")).toBeTruthy();
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (accounts as any).data = data;
  });

  it("renders the empty state when the provider has no accounts", () => {
    render(<AccountList providerId="anthropic-api" />);
    expect(
      screen.getByText(
        "No accounts yet — add one to start using this provider.",
      ),
    ).toBeTruthy();
  });

  it("renders a retryable error instead of a healthy empty state when inventory fails", () => {
    const data = accounts.data;
    // biome-ignore lint/suspicious/noExplicitAny: test toggles the hook's data shape
    (accounts as any).data = null;
    accounts.error = "Failed to load accounts: malformed response";
    render(<AccountList providerId="openai-api" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Failed to load accounts: malformed response",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(accounts.refresh).toHaveBeenCalledOnce();
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (accounts as any).data = data;
  });

  it("targets the repair dialog at the reauthenticated account and clears it for plain adds", () => {
    render(<AccountList providerId="openai-api" />);
    // Reauthenticate opens the dialog scoped to that unhealthy account.
    fireEvent.click(
      screen.getByRole("button", { name: "reauthenticate Second" }),
    );
    expect(screen.getByRole("dialog").textContent).toContain("second");
    // Closing clears the repair target...
    fireEvent.click(screen.getByRole("button", { name: "close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // ...so a plain "Add account" afterwards is NOT a repair (regression
    // guard: stale repair state must not leak into an unrelated add).
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(screen.getByRole("dialog").textContent).toContain("new");
  });

  it("resets a previous repair target when Add account is clicked directly", () => {
    render(<AccountList providerId="openai-api" />);
    fireEvent.click(
      screen.getByRole("button", { name: "reauthenticate Second" }),
    );
    expect(screen.getByRole("dialog").textContent).toContain("second");
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(screen.getByRole("dialog").textContent).toContain("new");
  });

  it("adopts the successful dialog response while refreshing the inventory", async () => {
    render(<AccountList providerId="openai-api" />);
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    fireEvent.click(screen.getByRole("button", { name: "finish add" }));
    await waitFor(() =>
      expect(accounts.refresh).toHaveBeenCalledWith({
        providerId: "openai-api",
        account: expect.objectContaining({ id: "created", label: "Created" }),
      }),
    );
  });

  it("swaps priorities with the neighbour via two patches", async () => {
    render(<AccountList providerId="openai-api" />);
    fireEvent.click(screen.getByRole("button", { name: "down First" }));
    await waitFor(() => expect(accounts.patch).toHaveBeenCalledTimes(2));
    expect(accounts.patch).toHaveBeenNthCalledWith(1, "openai-api", "first", {
      priority: 2,
    });
    expect(accounts.patch).toHaveBeenNthCalledWith(2, "openai-api", "second", {
      priority: 1,
    });
  });

  it("ignores moves past the list boundary", async () => {
    render(<AccountList providerId="openai-api" />);
    fireEvent.click(screen.getByRole("button", { name: "up First" }));
    fireEvent.click(screen.getByRole("button", { name: "down Second" }));
    await waitFor(() => expect(accounts.patch).not.toHaveBeenCalled());
  });

  it("rolls the first patch back when the neighbour patch fails", async () => {
    accounts.patch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    render(<AccountList providerId="openai-api" />);
    fireEvent.click(screen.getByRole("button", { name: "down First" }));
    await waitFor(() => expect(accounts.patch).toHaveBeenCalledTimes(3));
    expect(accounts.patch).toHaveBeenNthCalledWith(3, "openai-api", "first", {
      priority: 1,
    });
    expect(accounts.refresh).not.toHaveBeenCalled();
  });

  it("falls back to a server refresh when the rollback also fails", async () => {
    accounts.patch
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("rollback boom"));
    render(<AccountList providerId="openai-api" />);
    fireEvent.click(screen.getByRole("button", { name: "down First" }));
    await waitFor(() => expect(accounts.refresh).toHaveBeenCalledTimes(1));
  });

  it("reopens the add dialog when a persisted OAuth session resurfaces on focus", () => {
    render(<AccountList providerId="openai-api" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    mockedReadSubscriptionOAuth.mockReturnValue({
      providerId: "openai-api",
      sessionId: "session-1",
      // biome-ignore lint/suspicious/noExplicitAny: minimal persisted-session shape for the restore branch
    } as any);
    fireEvent(window, new Event("focus"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
