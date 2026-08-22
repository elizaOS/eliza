/** Verifies every server-owned account-deletion availability state in deterministic jsdom. */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getAccountDeletionAvailability: vi.fn(),
  submitAccountDeletion: vi.fn(),
  endLocalSessionAfterDeletion: vi.fn(),
}));

vi.mock("../data/account-deletion-client", () => client);

import { AccountDeletionDialog } from "./account-deletion-dialog";

const support = {
  email: "support@eliza.cloud",
  href: "mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request",
};

describe("AccountDeletionDialog", () => {
  beforeEach(() => {
    client.getAccountDeletionAvailability.mockReset();
  });

  afterEach(() => cleanup());

  it("keeps loading distinct from all terminal states", () => {
    client.getAccountDeletionAvailability.mockReturnValue(
      new Promise(() => undefined),
    );
    render(<AccountDeletionDialog />);
    expect(screen.getByRole("status").textContent).toContain(
      "Checking account deletion availability",
    );
    expect(screen.queryByTestId("delete-account-trigger")).toBeNull();
  });

  it("renders the available state as the confirmation trigger", async () => {
    client.getAccountDeletionAvailability.mockResolvedValue({
      status: "available",
      request: null,
      support: null,
    });
    render(<AccountDeletionDialog />);
    expect(await screen.findByTestId("delete-account-trigger")).toBeTruthy();
  });

  it("renders transfer-required with the server-owned support path", async () => {
    client.getAccountDeletionAvailability.mockResolvedValue({
      status: "transfer_required",
      request: null,
      support,
    });
    render(<AccountDeletionDialog />);
    expect(
      await screen.findByTestId("account-deletion-transfer-required"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: support.email }).getAttribute("href"),
    ).toBe(support.href);
    expect(screen.queryByTestId("delete-account-trigger")).toBeNull();
  });

  it("renders lifecycle-unavailable without fabricating a receipt", async () => {
    client.getAccountDeletionAvailability.mockResolvedValue({
      status: "lifecycle_unavailable",
      request: null,
      support,
    });
    render(<AccountDeletionDialog />);
    expect(
      await screen.findByTestId("account-deletion-lifecycle-unavailable"),
    ).toBeTruthy();
    expect(screen.getByText(/No deletion has been scheduled/i)).toBeTruthy();
    expect(screen.queryByText("Deletion scheduled")).toBeNull();
  });

  it("shows success only for an authenticated receipt returned by GET", async () => {
    client.getAccountDeletionAvailability.mockResolvedValue({
      status: "existing_receipt",
      request: {
        requestId: "receipt-1",
        status: "scheduled",
        requestedAt: "2026-08-19T00:00:00.000Z",
        scheduledDeletionAt: "2026-09-18T00:00:00.000Z",
        identityDeactivated: true,
        completedAt: null,
      },
      support: null,
    });
    render(<AccountDeletionDialog />);
    expect(await screen.findByTestId("account-deletion-receipt")).toBeTruthy();
    expect(screen.getByText("Deletion request on file")).toBeTruthy();
    expect(screen.getByText("receipt-1")).toBeTruthy();
  });

  it("renders request errors separately from unavailable states", async () => {
    client.getAccountDeletionAvailability.mockRejectedValue(
      new Error("status endpoint failed"),
    );
    render(<AccountDeletionDialog />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "status endpoint failed",
    );
    expect(
      screen.queryByTestId("account-deletion-lifecycle-unavailable"),
    ).toBeNull();
  });
});
