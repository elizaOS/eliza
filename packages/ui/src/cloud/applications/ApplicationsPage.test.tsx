import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApplicationsPage from "./ApplicationsPage";

const appsState = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    error: null as unknown,
    isError: false,
    isLoading: false,
  },
  session: {
    authenticated: true,
    ready: true,
  },
}));

vi.mock("../../cloud-ui/components/brand", () => ({
  BrandCard: ({ children }: { children: ReactNode }) => (
    <article>{children}</article>
  ),
  DashboardStatCard: ({
    label,
    value,
  }: {
    label: string;
    value: ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  ),
}));

vi.mock(
  "../../cloud-ui/components/dashboard/cloud-dashboard-components",
  () => ({
    AppsEmptyState: ({ action }: { action?: ReactNode }) => (
      <div data-testid="apps-empty">empty {action}</div>
    ),
    AppsPageWrapper: ({ children }: { children: ReactNode }) => (
      <section>{children}</section>
    ),
    AppsSkeleton: () => <div data-testid="apps-skeleton" />,
  }),
);

vi.mock("../../cloud-ui/components/dashboard/route-placeholders", () => ({
  DashboardErrorState: ({ message }: { message: string }) => (
    <div role="alert">{message}</div>
  ),
}));

vi.mock("../../cloud-ui/components/layout", () => ({
  DashboardPageContainer: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  DashboardStatGrid: ({ children, ...props }: { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  DashboardToolbar: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../../components/ui/skeleton", () => ({
  Skeleton: () => <span data-testid="stat-skeleton" />,
}));

vi.mock("../lib/use-session-auth", () => ({
  useRequireAuth: () => appsState.session,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? "",
}));

vi.mock("./components/apps-table", () => ({
  AppsTable: ({ apps }: { apps: unknown[] }) => (
    <div data-testid="apps-table">{apps.length} apps</div>
  ),
}));

vi.mock("./components/create-app-button", () => ({
  CreateAppButton: () => <button type="button">Create App</button>,
}));

vi.mock("./lib/apps", () => ({
  useApps: () => appsState.query,
}));

afterEach(() => {
  cleanup();
  appsState.query = {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  };
  appsState.session = {
    authenticated: true,
    ready: true,
  };
});

describe("ApplicationsPage", () => {
  it("renders stat skeletons instead of zero-valued success stats while loading", () => {
    appsState.query = {
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    };

    render(<ApplicationsPage />);

    expect(screen.getByTestId("apps-skeleton")).toBeInTheDocument();
    expect(screen.getAllByTestId("stat-skeleton")).toHaveLength(12);
    expect(screen.queryByText("Total Apps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apps-empty")).not.toBeInTheDocument();
  });

  it("renders an explicit error without success stats or empty state", () => {
    appsState.query = {
      data: undefined,
      error: new Error("apps unavailable"),
      isError: true,
      isLoading: false,
    };

    render(<ApplicationsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("apps unavailable");
    expect(screen.queryByText("Total Apps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("apps-empty")).not.toBeInTheDocument();
  });

  it("renders stats and table after apps resolve", () => {
    appsState.query = {
      data: [
        {
          app_id: "app-1",
          app_url: "https://app.example",
          client_id: "client-1",
          created_at: "2026-07-04T00:00:00Z",
          description: null,
          id: "app-1",
          is_active: true,
          name: "Launch App",
          total_requests: 17,
          total_users: 3,
          updated_at: "2026-07-04T00:00:00Z",
        },
      ],
      error: null,
      isError: false,
      isLoading: false,
    };

    render(<ApplicationsPage />);

    expect(screen.getByText("Total Apps")).toBeInTheDocument();
    expect(screen.getByText("Total Users")).toBeInTheDocument();
    expect(screen.getByTestId("apps-table")).toHaveTextContent("1 apps");
  });
});
