/**
 * Verifies the local Google setup panel uses one product-scoped OAuth flow and
 * never renders the generic OWNER/AGENT account choice.
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

const {
  connectorAccounts,
  navigatePreOpenedWindow,
  preOpenWindow,
  startOAuth,
} = vi.hoisted(() => ({
  connectorAccounts: {
    data: {
      provider: "google",
      connectorId: "google",
      accounts: [] as Array<Record<string, unknown>>,
    },
    accounts: [] as Array<Record<string, unknown>>,
    loading: false,
    error: null,
    saving: new Set<string>(),
    defaultAccountId: null as string | null,
    selectedAccountId: null as string | null,
    selectedAccount: null as Record<string, unknown> | null,
    effectiveAccountId: null as string | null,
    setSelectedAccountId: vi.fn(),
    refresh: vi.fn(async () => {}),
    add: vi.fn(),
    update: vi.fn(),
    test: vi.fn(),
    refreshAccount: vi.fn(),
    remove: vi.fn(),
    makeDefault: vi.fn(),
  },
  navigatePreOpenedWindow: vi.fn(),
  preOpenWindow: vi.fn(
    () => ({ closed: false, close: vi.fn() }) as unknown as Window,
  ),
  startOAuth: vi.fn<
    (input: {
      accountId?: string;
      scopes: string[];
    }) => Promise<{ authUrl: string }>
  >(async () => ({ authUrl: "https://accounts.google.test/auth" })),
}));

vi.mock("../../utils/openExternalUrl", () => ({
  navigatePreOpenedWindow,
  preOpenWindow,
}));

vi.mock("../../hooks/useConnectorAccounts", () => ({
  useConnectorAccounts: () => ({ ...connectorAccounts, startOAuth }),
}));

vi.mock("./ConnectorAccountList", () => ({
  ConnectorAccountList: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { ConnectorSetupPanel } from "./ConnectorSetupPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  connectorAccounts.data = {
    provider: "google",
    connectorId: "google",
    accounts: [],
  };
  connectorAccounts.accounts = [];
  connectorAccounts.selectedAccount = null;
  connectorAccounts.selectedAccountId = null;
  connectorAccounts.effectiveAccountId = null;
  connectorAccounts.defaultAccountId = null;
  connectorAccounts.saving = new Set<string>();
});

describe("local personal Google connector setup", () => {
  it("starts one draft-only OAuth grant for the selected MCP products", async () => {
    render(
      <ConnectorSetupPanel pluginId="connector-account-management:google:google" />,
    );

    expect(screen.queryByText("Agent accounts")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google account" }),
    );

    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(1));
    const request = startOAuth.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("OAuth request was not recorded");
    expect(request.scopes).toContain("gmail.draft");
    expect(request.scopes).toContain("calendar.read");
    expect(request.scopes).not.toContain("calendar.write");
    expect(request.scopes).not.toContain("gmail.send");
    expect(preOpenWindow).toHaveBeenCalledWith("eliza-google-oauth");
    expect(navigatePreOpenedWindow).toHaveBeenCalledWith(
      expect.anything(),
      "https://accounts.google.test/auth",
    );
  });

  it("renders an actionable error when Google OAuth cannot start", async () => {
    startOAuth.mockRejectedValueOnce(
      new Error(
        "This elizaOS build has no managed Google OAuth client registration.",
      ),
    );
    render(
      <ConnectorSetupPanel pluginId="connector-account-management:google:google" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Connect Google account" }),
    );

    const alert = await screen.findByRole("alert", undefined, {
      timeout: 1_000,
    });
    expect(alert.textContent).toContain(
      "Managed Google connection is unavailable in this build",
    );
    expect(
      screen.queryByRole("button", { name: "Open Vault secrets" }),
    ).toBeNull();
  });

  it("locks connected products and adds only new access to the selected account", async () => {
    const account = {
      id: "google-account-1",
      provider: "google",
      connectorId: "google",
      label: "Ada Lovelace",
      status: "connected",
      role: "OWNER",
      selectedProducts: ["gmail", "calendar"],
      enabled: true,
    };
    connectorAccounts.accounts = [account];
    connectorAccounts.data = {
      provider: "google",
      connectorId: "google",
      accounts: [account],
    };
    connectorAccounts.selectedAccount = account;
    connectorAccounts.selectedAccountId = account.id;
    connectorAccounts.effectiveAccountId = account.id;

    render(
      <ConnectorSetupPanel pluginId="connector-account-management:google:google" />,
    );

    expect(
      screen.queryByRole("button", { name: "Connect Google account" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    expect(screen.queryByText("Connected")).toBeNull();

    const gmail = screen.getByRole("checkbox", { name: /^Gmail/ });
    const calendar = screen.getByRole("checkbox", { name: /^Calendar/ });
    const drive = screen.getByRole("checkbox", { name: /^Drive/ });
    expect(gmail.getAttribute("aria-checked")).toBe("true");
    expect(gmail.hasAttribute("disabled")).toBe(true);
    expect(calendar.hasAttribute("disabled")).toBe(true);
    expect(drive.getAttribute("aria-checked")).toBe("false");
    expect(drive.hasAttribute("disabled")).toBe(false);

    fireEvent.click(drive);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 product" }));

    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(1));
    expect(startOAuth).toHaveBeenCalledWith({
      accountId: "google-account-1",
      scopes: expect.arrayContaining([
        "gmail.draft",
        "calendar.read",
        "drive.read",
      ]),
    });
  });
});
