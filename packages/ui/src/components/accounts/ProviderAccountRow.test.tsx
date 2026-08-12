/**
 * ProviderAccountRow desktop command-table switch: a pool trades its card
 * stack for AccountCommandTable only when BOTH the desktop media query
 * matches AND the pool has >= 4 accounts. Mobile widths and small pools keep
 * the richer AccountCard affordances, and table row actions must route back
 * through the owning provider id.
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountsListProvider,
  AccountWithCredentialFlag,
} from "../../api/client-agent";
import { ACCOUNT_PROVIDER_OPTIONS } from "./account-provider-options";
import { ProviderAccountRow } from "./ProviderAccountRow";

vi.mock("../../state/app-store", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (key, vars) => String(vars?.defaultValue ?? key) }),
}));

const mediaQueryState = { isDesktop: false };
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaQueryState.isDesktop,
}));

const maybeAnthropicOption = ACCOUNT_PROVIDER_OPTIONS.find(
  (option) => option.id === "anthropic-subscription",
);
if (!maybeAnthropicOption) {
  throw new Error("anthropic-subscription option missing");
}
const anthropicOption = maybeAnthropicOption;

function account(
  overrides: Partial<AccountWithCredentialFlag> = {},
): AccountWithCredentialFlag {
  return {
    id: overrides.id ?? "acc-1",
    providerId: "anthropic-subscription",
    label: overrides.label ?? "Account 1",
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: 0,
    health: "ok",
    hasCredential: true,
    ...overrides,
  } as AccountWithCredentialFlag;
}

function pool(size: number): AccountsListProvider {
  return {
    providerId: "anthropic-subscription",
    strategy: "priority",
    accounts: Array.from({ length: size }, (_, i) =>
      account({
        id: `acc-${i + 1}`,
        label: `Account ${i + 1}`,
        priority: i + 1,
      }),
    ),
  } as AccountsListProvider;
}

const asyncNoop = vi.fn().mockResolvedValue(undefined);

function renderRow(size: number) {
  return render(
    <ProviderAccountRow
      option={anthropicOption}
      provider={pool(size)}
      expanded
      onToggle={vi.fn()}
      onAdd={vi.fn()}
      saving={new Set<string>()}
      onPatch={asyncNoop}
      onMove={asyncNoop}
      onTest={asyncNoop}
      onRefreshUsage={asyncNoop}
      onDelete={asyncNoop}
      onStrategyChange={vi.fn()}
    />,
  );
}

describe("ProviderAccountRow command-table switch", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mediaQueryState.isDesktop = false;
  });

  it("uses the command table on desktop once the pool reaches 4 accounts", () => {
    mediaQueryState.isDesktop = true;
    renderRow(4);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByTestId("account-row-acc-1")).toBeTruthy();
    expect(screen.getByTestId("account-row-acc-4")).toBeTruthy();
  });

  it("keeps the card stack for small pools even on desktop", () => {
    mediaQueryState.isDesktop = true;
    renderRow(3);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Account 3")).toBeTruthy();
  });

  it("keeps the card stack off-desktop regardless of pool size", () => {
    mediaQueryState.isDesktop = false;
    renderRow(5);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Account 5")).toBeTruthy();
  });

  it("routes command-table row actions back through the provider id", async () => {
    mediaQueryState.isDesktop = true;
    renderRow(4);
    const toggle = screen.getByLabelText("Toggle Account 2");
    fireEvent.click(toggle);
    expect(asyncNoop).toHaveBeenCalledWith("anthropic-subscription", "acc-2", {
      enabled: false,
    });
  });
});

describe("ProviderAccountRow selection reason", () => {
  afterEach(cleanup);

  it("labels the active account as draining its weekly reset", () => {
    const provider: AccountsListProvider = {
      providerId: "anthropic-subscription",
      strategy: "drain-soonest-reset",
      selection: {
        activeAccountId: "fable-account",
        reason: "drain-soonest-reset",
      },
      accounts: [account({ id: "fable-account", label: "Fable weekly" })],
    } as AccountsListProvider;

    render(
      <ProviderAccountRow
        option={anthropicOption}
        provider={provider}
        expanded={false}
        onToggle={vi.fn()}
        onAdd={vi.fn()}
        saving={new Set()}
        onPatch={vi.fn()}
        onMove={vi.fn()}
        onTest={vi.fn()}
        onRefreshUsage={vi.fn()}
        onDelete={vi.fn()}
        onStrategyChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/draining weekly reset/i)).toBeTruthy();
  });
});
