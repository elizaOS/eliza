/** Proves the public deletion page never treats URL input as a scheduled receipt. */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../account-security/components/account-deletion-dialog", () => ({
  AccountDeletionDialog: () => (
    <div data-testid="server-owned-deletion-state" />
  ),
}));
vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("../../lib/use-page-title", () => ({ usePageTitle: vi.fn() }));

import AccountDeletionPage from "./account-deletion-page";

afterEach(() => cleanup());

describe("AccountDeletionPage", () => {
  it("ignores an untrusted requested query parameter and loads server state", () => {
    render(
      <MemoryRouter
        initialEntries={["/account-deletion?requested=forged-receipt"]}
      >
        <AccountDeletionPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("server-owned-deletion-state")).toBeTruthy();
    expect(screen.queryByText("Deletion scheduled")).toBeNull();
    expect(screen.queryByText("forged-receipt")).toBeNull();
  });
});
