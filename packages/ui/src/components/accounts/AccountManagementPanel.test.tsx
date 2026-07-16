/** Exercises consolidated account rendering and its mutation wiring. */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountManagementPanel } from "./AccountManagementPanel";

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
  error: null,
  patch: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
  refreshUsage: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  saving: new Set<string>(),
  setStrategy: vi.fn().mockResolvedValue(undefined),
  test: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../hooks/useAccounts", () => ({ useAccounts: () => accounts }));
vi.mock("../../providers", () => ({
  SUBSCRIPTION_PROVIDER_SELECTIONS: [],
}));
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
vi.mock("./AddAccountDialog", () => ({
  AddAccountDialog: ({
    open,
    credentialRepairAccount,
  }: {
    open: boolean;
    credentialRepairAccount?: { id: string } | null;
  }) =>
    open ? (
      <div role="dialog">add dialog {credentialRepairAccount?.id ?? "new"}</div>
    ) : null,
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
    onMoveDown,
    onTest,
    onRefreshUsage,
    onDelete,
    onReauthenticate,
  }: {
    account: { label: string };
    onMoveDown: () => void;
    onTest: () => void;
    onRefreshUsage: () => void;
    onDelete: () => void;
    onReauthenticate: () => void;
  }) => (
    <div>
      <span>{account.label}</span>
      <button type="button" onClick={onMoveDown}>
        move {account.label}
      </button>
      <button type="button" onClick={onTest}>
        test {account.label}
      </button>
      <button type="button" onClick={onRefreshUsage}>
        refresh {account.label}
      </button>
      <button type="button" onClick={onDelete}>
        delete {account.label}
      </button>
      <button type="button" onClick={onReauthenticate}>
        reauthenticate {account.label}
      </button>
    </div>
  ),
}));

describe("AccountManagementPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders health, opens add-account, and wires account operations", async () => {
    const onSelectChatProvider = vi.fn();
    render(
      <AccountManagementPanel
        activeSubscriptionId="openai-subscription"
        onSelectChatProvider={onSelectChatProvider}
        onSelectSubscription={vi.fn()}
      />,
    );
    // Unified surface: a provider with a needs-reauth account collapses to a
    // single "Needs attention" signal on the row header (no pill maze).
    expect(screen.getByText("Needs attention")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use for chat" }));
    expect(onSelectChatProvider).toHaveBeenCalledWith("openai-api");
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Account operations live behind progressive disclosure: expand the
    // connected provider row to reveal its account cards + strategy picker.
    const providerToggle = screen.getByRole("button", { name: /OpenAI API/ });
    // Product policy disables focus rings globally (styles.css); the provider
    // row toggle must not carry Tailwind focus/ring utilities — guards the
    // no-focus-ring-gate at the component level.
    const toggleClass = providerToggle.getAttribute("class") ?? "";
    expect(toggleClass).not.toMatch(
      /(?:^|\s)(?:focus|focus-visible|focus-within):/,
    );
    expect(toggleClass).not.toMatch(/(?:^|\s)!?ring-/);
    fireEvent.click(providerToggle);
    fireEvent.click(screen.getByRole("button", { name: "move First" }));
    await waitFor(() => expect(accounts.patch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "test First" }));
    fireEvent.click(screen.getByRole("button", { name: "refresh First" }));
    fireEvent.click(screen.getByRole("button", { name: "delete First" }));
    fireEvent.click(screen.getByRole("button", { name: "change strategy" }));
    expect(accounts.test).toHaveBeenCalledWith("openai-api", "first");
    expect(accounts.refreshUsage).toHaveBeenCalledWith("openai-api", "first");
    expect(accounts.remove).toHaveBeenCalledWith("openai-api", "first");
    expect(accounts.setStrategy).toHaveBeenCalledWith(
      "openai-api",
      "round-robin",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "reauthenticate Second" }),
    );
    expect(screen.getByRole("dialog").textContent).toContain("second");
  });
});
