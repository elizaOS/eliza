/** Verifies generic connector metadata drives explicit OAuth scope selection. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const startOAuth = vi.fn(async () => ({
  success: true,
  authUrl: "https://accounts.example/authorize",
}));

vi.mock("../../hooks/useConnectorAccounts", () => ({
  useConnectorAccounts: () => ({
    data: { provider: "google", connectorId: "google", accounts: [] },
    accounts: [],
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
  ConnectorAccountCard: () => null,
}));

import { ConnectorAccountList } from "./ConnectorAccountList";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
