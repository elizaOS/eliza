/** Verifies the shared Cloud account menu navigation and hardened sign-out boundary. */
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudI18nProvider } from "./CloudI18nProvider";

const clearSession = vi.hoisted(() => vi.fn());

vi.mock("./StewardProviderShared", () => ({
  clearStaleStewardSession: clearSession,
}));

import { CloudAccountMenu } from "./CloudAccountMenu";

function withCloudI18n(children: React.ReactNode): React.JSX.Element {
  return <CloudI18nProvider initialLang="en">{children}</CloudI18nProvider>;
}

function openMenu(): void {
  const trigger = screen.getByRole("button", {
    name: "Account menu for nubs@example.com",
  });
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
}

describe("CloudAccountMenu", () => {
  beforeEach(() => {
    clearSession.mockReset();
  });

  it("navigates to the canonical Account and Billing pages", async () => {
    render(
      withCloudI18n(
        <MemoryRouter initialEntries={["/cloud"]}>
          <Routes>
            <Route
              path="/cloud"
              element={<CloudAccountMenu email="nubs@example.com" />}
            />
            <Route path="/cloud/account" element={<div>Account page</div>} />
            <Route path="/cloud/billing" element={<div>Billing page</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Account" }));
    expect(await screen.findByText("Account page")).toBeTruthy();
  });

  it("uses the canonical Steward teardown before replacing with login", async () => {
    render(
      withCloudI18n(
        <MemoryRouter initialEntries={["/cloud"]}>
          <Routes>
            <Route
              path="/cloud"
              element={<CloudAccountMenu email="nubs@example.com" />}
            />
            <Route path="/login" element={<div>Login page</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(clearSession).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Login page")).toBeTruthy());
  });

  it("lets an isolated preview own its local-only teardown", async () => {
    const previewSignOut = vi.fn();
    render(
      withCloudI18n(
        <MemoryRouter>
          <CloudAccountMenu
            email="nubs@example.com"
            onSignOut={previewSignOut}
          />
        </MemoryRouter>,
      ),
    );

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(previewSignOut).toHaveBeenCalledTimes(1);
    expect(clearSession).not.toHaveBeenCalled();
  });
});
