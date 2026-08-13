/** Verifies OAuth capability state is visible on connector account cards. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorAccountRecord } from "../../api/client-agent";
import { ConnectorAccountCard } from "./ConnectorAccountCard";

const noop = vi.fn(async () => {});

const account: ConnectorAccountRecord = {
  id: "acct_google_1",
  provider: "google",
  connectorId: "google",
  label: "Google Owner",
  role: "OWNER",
  privacy: "owner_only",
  status: "needs-reauth",
  statusDetail:
    "Reconnect Google with calendar.read to continue calendar.listCalendars.",
  metadata: {
    grantedCapabilities: ["gmail.read"],
    requestedCapabilities: ["calendar.read"],
    reauthRequired: {
      missingCapabilities: ["calendar.read"],
    },
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectorAccountCard OAuth capabilities", () => {
  it("renders requested, granted, and missing capability ids", () => {
    render(
      <ConnectorAccountCard
        account={account}
        onUpdate={noop}
        onTest={noop}
        onRefresh={noop}
        onReauthorize={noop}
        onDelete={noop}
        onMakeDefault={noop}
      />,
    );

    expect(screen.getByText("Granted:")).toBeTruthy();
    expect(screen.getByText("gmail.read")).toBeTruthy();
    expect(screen.getByText("Requested:")).toBeTruthy();
    expect(screen.getByText("Missing:")).toBeTruthy();
    expect(screen.getAllByText("calendar.read")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Reconnect connector account" }),
    ).toBeTruthy();
  });
});
