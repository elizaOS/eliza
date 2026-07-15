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
      saving={false}
      onPatch={vi.fn().mockResolvedValue(undefined)}
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
});
