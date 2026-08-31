/**
 * Verifies the in-app Cloud page's runtime, authentication, and route gates
 * with deterministic app-state and route-registry collaborators.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedCloudPage } from "./ManagedCloudPage";

const mocks = vi.hoisted(() => ({
  ready: true,
  authenticated: true,
  user: { id: "u1", email: "nubs@example.com" } as {
    id: string;
    email: string;
  } | null,
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
        path: "cloud",
        group: "cloud",
        element: () => {
          useSetPageHeader({ title: "Overview" });
          return <div data-testid="cloud-overview" />;
        },
      },
      {
        path: "cloud/billing",
        group: "cloud",
        surface: {
          layout: {
            kind: "workspace",
            width: "wide",
            scroll: "view",
            gutter: "none",
          },
        },
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
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<div data-testid="login-page" />} />
        <Route path="*" element={<ManagedCloudPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.ready = true;
  mocks.authenticated = true;
  mocks.user = { id: "u1", email: "nubs@example.com" };
});

describe("ManagedCloudPage", () => {
  it("returns nested Cloud routes to the Cloud overview", () => {
    renderPage("/cloud/billing");

    fireEvent.click(
      screen.getByRole("button", { name: "Back to Cloud overview" }),
    );

    expect(screen.getByTestId("location").textContent).toBe("/cloud");
    expect(screen.getByTestId("cloud-overview")).toBeTruthy();
  });

  it("renders a registered /cloud route for an authenticated Cloud account", () => {
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
    const frame = screen
      .getByTestId("billing-page")
      .closest("[data-page-kind]");
    expect(frame?.getAttribute("data-page-kind")).toBe("workspace");
    expect(frame?.getAttribute("data-page-width")).toBe("wide");
    expect(frame?.getAttribute("data-page-gutter")).toBeNull();
    expect(
      frame
        ?.querySelector("[data-page-content]")
        ?.getAttribute("data-page-gutter"),
    ).toBe("none");
    expect(frame?.getAttribute("data-scroll-owner")).toBe("view");
    expect(frame?.className).toContain("overflow-hidden");
    expect(frame?.getAttribute("data-shell-scroll-region")).toBeNull();
    expect(document.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
  });

  it("keeps default managed pages reachable through one shell-owned scroller", () => {
    renderPage("/cloud");

    const overview = screen.getByTestId("cloud-overview");
    const frame = overview.closest<HTMLElement>("[data-scroll-owner]");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("data-scroll-owner")).toBe("shell");
    expect(frame?.className).toContain("overflow-y-auto");
    expect(frame?.getAttribute("data-shell-scroll-region")).toBe("true");
    expect(
      frame?.querySelector('[data-shell-scroll-region="true"]'),
    ).toBeNull();
    expect(frame?.contains(overview)).toBe(true);
    expect(document.querySelectorAll("[data-scroll-owner]")).toHaveLength(1);
    expect(frame?.querySelector("[data-scroll-owner]")).toBeNull();
  });

  it("does not require a managed agent runtime for an authenticated Cloud account", () => {
    renderPage("/cloud/billing");
    expect(screen.getByTestId("billing-page")).toBeTruthy();
    expect(
      screen.queryByText(
        "Cloud management is available for agents deployed to Eliza Cloud.",
      ),
    ).toBeNull();
  });

  it("shows an accessible dashboard loading state while session auth resolves", () => {
    mocks.ready = false;
    renderPage("/cloud");

    expect(
      screen.getByRole("status", { name: "Loading Cloud dashboard" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("cloud-overview")).toBeNull();
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
