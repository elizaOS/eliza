/** Exercises public deletion status, cancellation fencing, and visible error states in jsdom. */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ ready: true, authenticated: false }));
const readStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionMock,
}));

vi.mock("../../lib/use-page-title", () => ({
  usePageTitle: vi.fn(),
}));

vi.mock("../../../account-security/components/account-deletion-dialog", () => ({
  AccountDeletionDialog: () => <button type="button">Request deletion</button>,
}));

vi.mock("../../../account-security/data/account-deletion-client", () => ({
  cancelAccountDeletion: vi.fn(),
  downloadAccountDeletionExport: vi.fn(),
  readAccountDeletionStatus: readStatusMock,
}));

import AccountDeletionPage from "./account-deletion-page";

describe("AccountDeletionPage", () => {
  beforeEach(() => {
    readStatusMock.mockReset();
    sessionMock.ready = true;
    sessionMock.authenticated = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps an invalid or expired capability visibly distinct from no request", async () => {
    readStatusMock.mockRejectedValueOnce(
      new Error("Deletion status credential is invalid or expired"),
    );

    render(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Deletion status credential is invalid or expired",
    );
    expect(
      screen
        .getByRole("link", { name: "Sign in to request deletion" })
        .getAttribute("href"),
    ).toBe("/login?returnTo=%2Faccount-deletion");
  });

  it("renders canceling as nonterminal and keeps access visibly fenced", async () => {
    readStatusMock.mockResolvedValueOnce({
      requestId: "33333333-3333-4333-8333-333333333333",
      status: "canceling",
      requestedAt: "2026-08-22T12:00:00.000Z",
      recoveryExpiresAt: "2026-09-21T12:00:00.000Z",
      scheduledDeletionAt: "2026-09-21T12:00:00.000Z",
      irreversibleAt: null,
      completedAt: null,
      identityDeactivated: true,
      accessState: "fenced",
      canCancel: false,
      nextAction: "wait_for_reconciliation",
      export: null,
    });

    render(
      <MemoryRouter>
        <AccountDeletionPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Cancellation cleanup in progress",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Account access remains disabled until export cleanup and identity reactivation are durably complete.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Cancel account deletion" }),
    ).toBeNull();
  });
});
