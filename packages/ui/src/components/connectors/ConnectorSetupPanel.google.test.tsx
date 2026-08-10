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

const { startOAuth } = vi.hoisted(() => ({
  startOAuth: vi.fn<
    (input: { scopes: string[] }) => Promise<{ authUrl: string }>
  >(async () => ({ authUrl: "https://accounts.google.test/auth" })),
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

vi.mock("./ConnectorAccountList", () => ({
  ConnectorAccountList: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { ConnectorSetupPanel } from "./ConnectorSetupPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("local personal Google connector setup", () => {
  it("starts one draft-only OAuth grant for the selected MCP products", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <ConnectorSetupPanel pluginId="connector-account-management:google:google" />,
    );

    expect(screen.queryByText("Agent accounts")).toBeNull();
    expect(screen.getByText("Personal Google accounts")).toBeTruthy();
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
    expect(open).toHaveBeenCalledWith(
      "https://accounts.google.test/auth",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
