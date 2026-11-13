// @vitest-environment jsdom
/** Actual authenticated page/query keys; only principal and HTTP provider are controlled. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
const principal = vi.hoisted(() => ({
  current: {
    ready: true,
    authenticated: true,
    user: { id: "user-a", email: "a@example.invalid" },
  },
}));
vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => principal.current,
}));
import { toast } from "../../../../bridge/toast";
import { CloudI18nProvider } from "../../../shell/CloudI18nProvider";
import ApplicationsPage from "../../ApplicationsPage";
import { APPS_QUERY_KEY } from "../apps";
import { organizationQueryKeys } from "../../../organization/data/use-organization";
import { appDeletionFixture } from "./app-deletion-fixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the actual page retains pending rows through an empty scoped refetch and drops them at an organization switch", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let organizationId = "org-a";
  let apps = [
    { ...appDeletionFixture("one"), organization_id: organizationId },
  ];
  let release!: () => void,
    polling = false;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  const success = vi.spyOn(toast, "success");
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/user"))
        return Response.json({
          success: true,
          data: {
            id: principal.current.user.id,
            organization_id: organizationId,
            organization: null,
            role: "owner",
          },
        });
      if (path.endsWith("/api/v1/apps"))
        return Response.json({ success: true, apps });
      if (init?.method === "DELETE")
        return Response.json(
          {
            success: false,
            state: "pending",
            status: "pending",
            appId: "one",
            jobId: "job-one",
          },
          { status: 202 },
        );
      polling = true;
      await receipt;
      return Response.json({
        success: true,
        data: {
          id: "job-one",
          type: "app_delete",
          status: "completed",
          result: {
            appDeleted: true,
            appId: "one",
            deletionJobId: "job-one",
            cleanupConfirmed: true,
          },
        },
      });
    },
  );
  function Surface() {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CloudI18nProvider initialLang="en">
            <ApplicationsPage />
          </CloudI18nProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  const view = render(<Surface />);
  const user = userEvent.setup();
  await screen.findByText("App one");
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(polling).toBe(true));
  apps = [];
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: [...APPS_QUERY_KEY, "auth", "user-a"],
    });
  });
  expect(screen.getByText("App one")).toBeTruthy();
  expect(screen.getByText("Deleting…")).toBeTruthy();
  organizationId = "org-b";
  apps = [{ ...appDeletionFixture("two"), organization_id: organizationId }];
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: [...organizationQueryKeys.user, "auth", "user-a"],
    });
  });
  view.rerender(<Surface />);
  await screen.findByText("App two");
  expect(screen.queryByText("App one")).toBeNull();
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(success).not.toHaveBeenCalled();
  expect(
    queryClient.getQueryData([...APPS_QUERY_KEY, "auth", "user-a"]),
  ).toEqual(apps);
  queryClient.clear();
});

test("the actual page removes a confirmed deletion from its authenticated cache despite a stale list response", async () => {
  principal.current = {
    ready: true,
    authenticated: true,
    user: { id: "user-a", email: "a@example.invalid" },
  };
  const app = { ...appDeletionFixture("one"), organization_id: "org-a" };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let release!: () => void,
    polling = false;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/v1/user"))
        return Response.json({
          success: true,
          data: {
            id: "user-a",
            organization_id: "org-a",
            organization: null,
            role: "owner",
          },
        });
      if (path.endsWith("/api/v1/apps"))
        return Response.json({ success: true, apps: [app] });
      if (init?.method === "DELETE")
        return Response.json(
          {
            success: false,
            state: "pending",
            status: "pending",
            appId: "one",
            jobId: "job-one",
          },
          { status: 202 },
        );
      polling = true;
      await receipt;
      return Response.json({
        success: true,
        data: {
          id: "job-one",
          type: "app_delete",
          status: "completed",
          result: {
            appDeleted: true,
            appId: "one",
            deletionJobId: "job-one",
            cleanupConfirmed: true,
          },
        },
      });
    },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CloudI18nProvider initialLang="en">
          <ApplicationsPage />
        </CloudI18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await screen.findByText("App one");
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(polling).toBe(true));
  await act(async () => {
    release();
  });
  await waitFor(() => expect(screen.queryByText("App one")).toBeNull());
  expect(
    queryClient.getQueryData([...APPS_QUERY_KEY, "auth", "user-a"]),
  ).toEqual([]);
  queryClient.clear();
});
