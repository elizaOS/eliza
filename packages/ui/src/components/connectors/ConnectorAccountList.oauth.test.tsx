/** Verifies generic connector metadata drives explicit OAuth scope selection. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorAccountRecord } from "../../api/client-agent";

const startOAuth = vi.fn(async () => ({
  success: true,
  authUrl: "https://accounts.example/authorize",
}));
let accounts: ConnectorAccountRecord[] = [];

vi.mock("../../hooks/useConnectorAccounts", () => ({
  useConnectorAccounts: () => ({
    data: { provider: "google", connectorId: "google", accounts },
    accounts,
    loading: false,
    error: null,
    saving: new Set<string>(),
    defaultAccountId: null,
    selectedAccountId: null,
    selectedAccount: null,
    effectiveAccountId: null,
    setSelectedAccountId: vi.fn(),
    refresh: vi.fn(async () => {}),
    add: vi.fn(),
    startOAuth,
    update: vi.fn(),
    test: vi.fn(),
    refreshAccount: vi.fn(),
    remove: vi.fn(),
    makeDefault: vi.fn(),
  }),
}));

vi.mock("./ConnectorAccountCard", () => ({
  ConnectorAccountCard: ({
    account,
    onReauthorize,
    reauthorizeDisabled,
  }: {
    account: ConnectorAccountRecord;
    onReauthorize?: () => Promise<void>;
    reauthorizeDisabled?: boolean;
  }) => (
    <div>
      <span>{account.label}</span>
      {onReauthorize ? (
        <button
          type="button"
          disabled={reauthorizeDisabled}
          onClick={() => void onReauthorize()}
        >
          Reconnect {account.id}
        </button>
      ) : null}
    </div>
  ),
}));

import { ConnectorAccountList } from "./ConnectorAccountList";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  accounts = [];
});

describe("ConnectorAccountList OAuth capabilities", () => {
  it("requires a declared capability and sends only the selected ids", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ConnectorAccountList provider="google" connectorId="google" />);
    const add = screen.getByRole("button", { name: "Add account" });
    expect((add as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Read Gmail"));
    expect((add as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(add);

    await vi.waitFor(() => {
      expect(startOAuth).toHaveBeenCalledWith({
        scopes: ["gmail.read"],
        metadata: {
          requestedCapabilities: ["gmail.read"],
          requestedRole: "OWNER",
          privacy: "owner_only",
        },
      });
    });
  });

  it("reauthorizes an existing account with explicit fallback capabilities", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    accounts = [
      {
        id: "acct_legacy",
        provider: "google",
        connectorId: "google",
        label: "Legacy Google",
        role: "OWNER",
        privacy: "owner_only",
        status: "needs-reauth",
        metadata: {
          reauthRequired: {
            missingCapabilities: ["calendar.read"],
          },
        },
      },
    ];

    render(<ConnectorAccountList provider="google" connectorId="google" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect acct_legacy" }),
    );

    await vi.waitFor(() => {
      expect(startOAuth).toHaveBeenCalledWith({
        accountId: "acct_legacy",
        scopes: ["calendar.read"],
        metadata: {
          requestedCapabilities: ["calendar.read"],
          requestedRole: "OWNER",
          privacy: "owner_only",
        },
      });
    });
  });

  it("keeps reconnect disabled until a capability is selected when no account grant is known", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    accounts = [
      {
        id: "acct_unknown_grant",
        provider: "google",
        connectorId: "google",
        label: "Unknown Grant",
        role: "OWNER",
        privacy: "owner_only",
        status: "needs-reauth",
        metadata: {},
      },
    ];

    render(<ConnectorAccountList provider="google" connectorId="google" />);
    const reconnect = screen.getByRole("button", {
      name: "Reconnect acct_unknown_grant",
    });
    expect((reconnect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Read Calendar"));
    expect((reconnect as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reconnect);

    await vi.waitFor(() => {
      expect(startOAuth).toHaveBeenCalledWith({
        accountId: "acct_unknown_grant",
        scopes: ["calendar.read"],
        metadata: {
          requestedCapabilities: ["calendar.read"],
          requestedRole: "OWNER",
          privacy: "owner_only",
        },
      });
    });
  });
});
