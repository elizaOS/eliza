/**
 * Verifies the in-app Cloud page's runtime, authentication, and route gates
 * with deterministic app-state and route-registry collaborators.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedCloudPage } from "./ManagedCloudPage";

const mocks = vi.hoisted(() => ({
  target: "cloud-managed",
  ready: true,
  authenticated: true,
  appModeHost: false,
  user: { id: "u1", email: "nubs@example.com" } as {
    id: string;
    email: string;
  } | null,
}));

vi.mock("../app-mode/app-mode", () => ({
  isAppModeHost: () => mocks.appModeHost,
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: { startupCoordinator: { target: string } }) => unknown,
  ) => selector({ startupCoordinator: { target: mocks.target } }),
}));

vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: mocks.ready,
    authenticated: mocks.authenticated,
    user: mocks.user,
  }),
}));

vi.mock("./CloudAccountMenu", () => ({
  CloudAccountMenu: ({ email }: { email: string | null }) => (
    <button type="button">Account menu for {email}</button>
  ),
}));

vi.mock("./CloudRouteErrorBoundary", () => ({
  CloudRouteErrorBoundary: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("./cloud-route-registry", async () => {
  const { useSetPageHeader } = await vi.importActual<
    typeof import("../../cloud-ui/components/layout")
  >("../../cloud-ui/components/layout");
  return {
    getCloudRouteGate: () => undefined,
    listCloudRoutes: () => [
      {
        path: "cloud/billing",
        group: "cloud",
        element: () => {
          useSetPageHeader({
            title: "Cloud Billing",
            description: "Manage credits and invoices.",
            actions: <button type="button">Add credits</button>,
          });
          return <div data-testid="billing-page" />;
        },
      },
      {
        path: "cloud/admin",
        group: "admin",
        element: () => <div data-testid="admin-page" />,
      },
      {
        path: "cloud/public-auth",
        group: "auth",
        element: () => <div data-testid="auth-page" />,
      },
    ],
  };
});

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderPage(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LocationProbe />} />
        <Route path="*" element={<ManagedCloudPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.target = "cloud-managed";
  mocks.ready = true;
  mocks.authenticated = true;
  mocks.appModeHost = false;
  mocks.user = { id: "u1", email: "nubs@example.com" };
});

describe("ManagedCloudPage", () => {
  it("renders a registered /cloud route inside the app for cloud-managed agents", () => {
    renderPage("/cloud/billing");
    expect(screen.getByTestId("billing-page")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Cloud Billing", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add credits" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Account menu for nubs@example.com",
      }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("view-header")).toHaveLength(1);
  });

  it("hides Cloud management for local and VPS agents", () => {
    mocks.target = "local";
    renderPage("/cloud/billing");
    expect(
      screen.getByText(
        "Cloud management is available for agents deployed to Eliza Cloud.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("billing-page")).toBeNull();
  });

  it("shows Cloud management on the canonical hosted Cloud app before an agent binding is restored", () => {
    mocks.target = "local";
    mocks.appModeHost = true;
    renderPage("/cloud/billing");
    expect(screen.getByTestId("billing-page")).toBeTruthy();
  });

  it("sends signed-out managed agents through eliza.app login with returnTo", () => {
    mocks.authenticated = false;
    renderPage("/cloud/admin?from=agent");
    expect(screen.getByTestId("location").textContent).toBe(
      "/login?returnTo=%2Fcloud%2Fadmin%3Ffrom%3Dagent",
    );
  });

  it("does not expose public/auth route groups through the Cloud page", () => {
    renderPage("/cloud/public-auth");
    expect(screen.queryByTestId("auth-page")).toBeNull();
    expect(screen.getByText("Cloud management page not found.")).toBeTruthy();
  });
});
