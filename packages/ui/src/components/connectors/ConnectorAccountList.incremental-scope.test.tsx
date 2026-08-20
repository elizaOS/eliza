/**
 * Integration coverage for the unified Connections capability UI (#19884):
 * the incremental-scope grant flow (missing capability chip → OAuth restart
 * carrying the union of granted + requested scopes → return renders the
 * capability as granted), the per-account Reconnect affordance for
 * reauth-required accounts, and the distinct "access not reported" state.
 * The account-list hook is mocked; the card, chips, and presentation model
 * under test are real.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorAccountRecord } from "../../api/client-agent-connector-accounts";

const startOAuth = vi.fn(async () => ({
  ok: true,
  success: true,
  authUrl: "https://accounts.example/authorize",
}));

let currentAccounts: ConnectorAccountRecord[] = [];

vi.mock("../../hooks/useConnectorAccounts", () => ({
  useConnectorAccounts: () => ({
    data: {
      provider: "google",
      connectorId: "google",
      accounts: currentAccounts,
    },
    accounts: currentAccounts,
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

import { ConnectorAccountList } from "./ConnectorAccountList";

function account(
  overrides: Partial<ConnectorAccountRecord>,
): ConnectorAccountRecord {
  return {
    id: "acct-1",
    provider: "google",
    connectorId: "google",
    label: "Work Gmail",
    status: "connected",
    role: "OWNER",
    purpose: ["messaging"],
    privacy: "owner_only",
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  currentAccounts = [];
});

describe("ConnectorAccountList incremental scope", () => {
  it("grants a missing capability with the union of granted + requested scopes, then shows it granted after return", async () => {
    currentAccounts = [
      account({
        metadata: { grantedCapabilities: ["gmail.read"] },
      }),
    ];
    const view = render(
      <ConnectorAccountList provider="google" connectorId="google" />,
    );

    const readChip = screen.getByTestId("capability-chip-gmail.read");
    expect(readChip.getAttribute("data-state")).toBe("granted");
    const sendChip = screen.getByTestId("capability-chip-gmail.send");
    expect(sendChip.getAttribute("data-state")).toBe("missing");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Grant Send Gmail" }));
    });

    expect(startOAuth).toHaveBeenCalledWith({
      accountId: "acct-1",
      scopes: ["gmail.read", "gmail.send"],
      metadata: {
        requestedCapabilities: ["gmail.read", "gmail.send"],
        requestedRole: "OWNER",
        privacy: "owner_only",
      },
    });

    // Simulate returning from the provider: the poll now reports the grant.
    currentAccounts = [
      account({
        metadata: { grantedCapabilities: ["gmail.read", "gmail.send"] },
      }),
    ];
    view.rerender(
      <ConnectorAccountList provider="google" connectorId="google" />,
    );
    expect(
      screen
        .getByTestId("capability-chip-gmail.send")
        .getAttribute("data-state"),
    ).toBe("granted");
    expect(
      screen.queryByRole("button", { name: "Grant Send Gmail" }),
    ).toBeNull();
  });

  it("offers Reconnect on a reauth-required account and re-requests its granted scopes", async () => {
    currentAccounts = [
      account({
        status: "needs-reauth",
        metadata: { grantedCapabilities: ["gmail.send", "gmail.read"] },
      }),
    ];
    render(<ConnectorAccountList provider="google" connectorId="google" />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Reconnect account" }),
      );
    });

    expect(startOAuth).toHaveBeenCalledWith({
      accountId: "acct-1",
      scopes: ["gmail.read", "gmail.send"],
      metadata: {
        requestedCapabilities: ["gmail.read", "gmail.send"],
        requestedRole: "OWNER",
        privacy: "owner_only",
      },
    });
  });

  it("renders the distinct access-not-reported state instead of empty-healthy chips", () => {
    currentAccounts = [account({ metadata: {} })];
    render(<ConnectorAccountList provider="google" connectorId="google" />);
    expect(screen.getByTestId("capability-access-unreported")).toBeTruthy();
    expect(screen.queryByTestId("capability-chips")).toBeNull();
  });

  it("does not offer Reconnect on a healthy connected account", () => {
    currentAccounts = [
      account({ metadata: { grantedCapabilities: ["gmail.read"] } }),
    ];
    render(<ConnectorAccountList provider="google" connectorId="google" />);
    expect(
      screen.queryByRole("button", { name: "Reconnect account" }),
    ).toBeNull();
  });
});
