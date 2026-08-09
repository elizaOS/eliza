/**
 * Verifies mixed plugin-managed account records are filtered by their actual
 * stored role for the active identity lens; deterministic hooks, no backend.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorAccountRecord } from "../../api/client-agent";

const records: ConnectorAccountRecord[] = [
  {
    id: "owner-1",
    provider: "slack",
    connectorId: "slack",
    label: "Owner record",
    role: "OWNER",
    status: "connected",
  },
  {
    id: "agent-1",
    provider: "slack",
    connectorId: "slack",
    label: "Agent record",
    role: "AGENT",
    status: "connected",
  },
  {
    id: "team-1",
    provider: "slack",
    connectorId: "slack",
    label: "Team record",
    role: "TEAM",
    status: "connected",
  },
  {
    id: "unknown-1",
    provider: "slack",
    connectorId: "slack",
    label: "Unknown record",
    status: "connected",
  },
];

vi.mock("../../hooks/useConnectorAccounts", () => ({
  useConnectorAccounts: () => ({
    data: { provider: "slack", connectorId: "slack", accounts: records },
    accounts: records,
    loading: false,
    error: null,
    saving: new Set<string>(),
    defaultAccountId: null,
    selectedAccountId: null,
    selectedAccount: null,
    effectiveAccountId: null,
    setSelectedAccountId: vi.fn(),
    refresh: vi.fn(async () => {}),
    add: vi.fn(async () => ({ success: true })),
    startOAuth: vi.fn(async () => ({ success: true })),
    update: vi.fn(async (_id, body) => ({ ...records[0], ...body })),
    test: vi.fn(async () => ({ success: true })),
    refreshAccount: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true })),
    makeDefault: vi.fn(async () => ({ success: true })),
  }),
}));

vi.mock("./ConnectorAccountCard", () => ({
  ConnectorAccountCard: ({ account }: { account: ConnectorAccountRecord }) => (
    <div>{account.label}</div>
  ),
}));

import { OwnerAgentConnectorSetupPanel } from "./OwnerAgentConnectorSetupPanel";

afterEach(cleanup);

describe("OwnerAgentConnectorSetupPanel", () => {
  it("shows OWNER plus neutral TEAM/unknown records in Delegate", () => {
    render(
      <OwnerAgentConnectorSetupPanel
        provider="slack"
        enableOwner
        enableAgent={false}
        enableTeam
      />,
    );

    expect(screen.getByText("Owner record")).toBeTruthy();
    expect(screen.queryByText("Agent record")).toBeNull();
    expect(screen.getByText("Team record")).toBeTruthy();
    expect(screen.getByText("Unknown record")).toBeTruthy();
  });

  it("shows AGENT plus neutral TEAM/unknown records in Bot", () => {
    render(
      <OwnerAgentConnectorSetupPanel
        provider="slack"
        enableOwner={false}
        enableAgent
        enableTeam
      />,
    );

    expect(screen.queryByText("Owner record")).toBeNull();
    expect(screen.getByText("Agent record")).toBeTruthy();
    expect(screen.getByText("Team record")).toBeTruthy();
    expect(screen.getByText("Unknown record")).toBeTruthy();
  });
});
