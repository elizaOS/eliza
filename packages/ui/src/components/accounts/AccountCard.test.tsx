/** Focused account-row coverage for health treatment and credential repair. */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountWithCredentialFlag } from "../../api/client-agent";
import { AccountCard } from "./AccountCard";

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (key, vars) => String(vars?.defaultValue ?? key) }),
}));

const baseAccount: AccountWithCredentialFlag = {
  id: "account-primary",
  providerId: "openai-codex",
  label: "Production Codex",
  source: "oauth",
  enabled: true,
  priority: 0,
  createdAt: Date.now() - 86_400_000,
  lastUsedAt: Date.now() - 60_000,
  health: "ok",
  hasCredential: true,
};

function renderAccount(
  account: AccountWithCredentialFlag,
  onReauthenticate = vi.fn(),
) {
  render(
    <AccountCard
      account={account}
      isFirst
      isLast
      saving={false}
      onPatch={vi.fn().mockResolvedValue(undefined)}
      onMoveUp={vi.fn().mockResolvedValue(undefined)}
      onMoveDown={vi.fn().mockResolvedValue(undefined)}
      onTest={vi.fn().mockResolvedValue(undefined)}
      onRefreshUsage={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onReauthenticate={onReauthenticate}
    />,
  );
  return onReauthenticate;
}

describe("AccountCard health and repair actions", () => {
  afterEach(cleanup);

  it("prominently renders needs-reauth reason and dispatches reauthentication", () => {
    const onReauthenticate = renderAccount({
      ...baseAccount,
      health: "needs-reauth",
      healthDetail: { lastError: "Refresh token expired" },
    });

    expect(screen.getByText("Needs reauth")).toBeTruthy();
    expect(screen.getByText("Refresh token expired")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reauthenticate" }));
    expect(onReauthenticate).toHaveBeenCalledTimes(1);
  });

  it("uses replacement language for invalid API credentials", () => {
    const onReauthenticate = renderAccount({
      ...baseAccount,
      providerId: "openai-api",
      source: "api-key",
      health: "invalid",
    });

    expect(screen.getByText("Invalid credential")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace credential" }));
    expect(onReauthenticate).toHaveBeenCalledTimes(1);
  });

  it("keeps rate limits distinct from credential failures", () => {
    renderAccount({
      ...baseAccount,
      health: "rate-limited",
      healthDetail: { until: Date.now() + 3_600_000 },
    });

    expect(screen.getByText(/Rate-limited/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reauthenticate" })).toBeNull();
  });

  it("labels the Anthropic weekly reset only on the 7d bar", () => {
    renderAccount({
      ...baseAccount,
      providerId: "anthropic-subscription",
      usage: {
        sessionPct: 1,
        weeklyPct: 6,
        resetsAt: Date.now() + 2 * 86_400_000,
        refreshedAt: Date.now(),
      },
    });

    expect(
      document.querySelector('[title^="5h: 1%"]')?.getAttribute("title"),
    ).toBe("5h: 1%");
    expect(
      document.querySelector('[title^="7d: 6%"]')?.getAttribute("title"),
    ).toMatch(/^7d: 6% · resets in /);
  });

  it("does not label the Codex primary reset as the weekly reset", () => {
    renderAccount({
      ...baseAccount,
      usage: {
        sessionPct: 1,
        weeklyPct: 6,
        resetsAt: Date.now() + 2 * 86_400_000,
        refreshedAt: Date.now(),
      },
    });

    expect(
      document.querySelector('[title^="5h: 1%"]')?.getAttribute("title"),
    ).toMatch(/^5h: 1% · resets in /);
    expect(
      document.querySelector('[title^="7d: 6%"]')?.getAttribute("title"),
    ).toBe("7d: 6%");
  });

  it("renders expired as a distinct non-reauth health state", () => {
    renderAccount({
      ...baseAccount,
      health: "expired",
      subscriptionEndsAt: Date.now() - 1,
    });

    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reauthenticate" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Replace credential" }),
    ).toBeNull();
  });
});
