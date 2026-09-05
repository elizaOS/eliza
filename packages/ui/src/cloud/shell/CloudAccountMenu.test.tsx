/** Verifies the shared Cloud account menu navigation and hardened sign-out boundary. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudI18nProvider } from "./CloudI18nProvider";

const signOutSession = vi.hoisted(() => vi.fn());

vi.mock("../sso-bridge/sso-bridge", () => ({
  signOutFromSsoBridgedHost: signOutSession,
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
    signOutSession.mockReset();
    signOutSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
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

  it("uses the cross-host server logout before replacing with login", async () => {
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

    await waitFor(() => expect(signOutSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Login page")).toBeTruthy());
  });

  it("keeps the authenticated route and offers a retry when teardown fails", async () => {
    signOutSession.mockRejectedValueOnce(new Error("storage unavailable"));
    render(
      withCloudI18n(
        <MemoryRouter initialEntries={["/cloud"]}>
          <Routes>
            <Route
              path="/cloud"
              element={
                <div>
                  <span>Cloud page</span>
                  <CloudAccountMenu email="nubs@example.com" />
                </div>
              }
            />
            <Route path="/login" element={<div>Login page</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not sign out safely. Please try again.",
    );
    expect(screen.getByText("Cloud page")).toBeTruthy();
    expect(screen.queryByText("Login page")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await screen.findByText("Login page");
    expect(signOutSession).toHaveBeenCalledTimes(2);
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
    expect(signOutSession).not.toHaveBeenCalled();
  });
});
