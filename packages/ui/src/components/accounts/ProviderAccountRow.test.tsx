// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountsListProvider } from "../../api/client-agent";
import { getAccountProviderOption } from "./account-provider-options";
import { ProviderAccountRow } from "./ProviderAccountRow";

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) =>
    selector({
      t: (_key, vars) => String(vars?.defaultValue ?? vars?.reason ?? ""),
    }),
}));

describe("ProviderAccountRow selection reason", () => {
  afterEach(cleanup);

  it("labels the active account as draining its weekly reset", () => {
    const option = getAccountProviderOption("anthropic-subscription");
    if (!option) throw new Error("missing Anthropic provider option");
    const provider: AccountsListProvider = {
      providerId: "anthropic-subscription",
      strategy: "drain-soonest-reset",
      selection: {
        activeAccountId: "fable-account",
        reason: "drain-soonest-reset",
      },
      accounts: [
        {
          id: "fable-account",
          providerId: "anthropic-subscription",
          label: "Fable weekly",
          source: "oauth",
          enabled: true,
          priority: 0,
          createdAt: Date.now() - 1000,
          health: "ok",
          hasCredential: true,
        },
      ],
    };

    render(
      <ProviderAccountRow
        option={option}
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
