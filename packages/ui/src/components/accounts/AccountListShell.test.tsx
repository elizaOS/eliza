/** Deterministic component coverage for the canonical account-list presentation states. */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountListShell } from "./AccountListShell";

afterEach(cleanup);

describe("AccountListShell", () => {
  it.each([
    ["loading", { kind: "loading", label: "Loading accounts…" } as const],
    ["error", { kind: "error", message: "Accounts unavailable" } as const],
    ["empty", { kind: "empty", message: "No accounts yet" } as const],
  ])("renders the exclusive %s state", (_, state) => {
    render(<AccountListShell heading="Accounts (0)" state={state} />);
    expect(screen.getByRole("heading", { name: "Accounts (0)" })).toBeTruthy();
    expect(screen.queryByText("Ready account")).toBeNull();
  });

  it("composes adapter controls, a recoverable notice, and ready content", () => {
    render(
      <AccountListShell
        heading="Connector accounts (1)"
        action={<button type="button">Add account</button>}
        controls={<div>OAuth scopes</div>}
        notice={{ message: "Refresh failed" }}
        state={{ kind: "ready", children: <div>Ready account</div> }}
      />,
    );
    expect(screen.getByRole("button", { name: "Add account" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Refresh failed");
    expect(screen.getByText("OAuth scopes")).toBeTruthy();
    expect(screen.getByText("Ready account")).toBeTruthy();
  });
});
