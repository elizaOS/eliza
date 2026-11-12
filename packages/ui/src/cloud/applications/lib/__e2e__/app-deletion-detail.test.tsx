// @vitest-environment jsdom
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
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
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
import ApplicationDetailPage from "../../ApplicationDetailPage";
import { organizationQueryKeys } from "../../../organization/data/use-organization";
import { appDeletionFixture } from "./app-deletion-fixture";
const id = "db658ce3-a7d8-4dc4-9b8e-65c1bbce2001";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  principal.current = {
    ready: true,
    authenticated: true,
    user: { id: "user-a", email: "a@example.invalid" },
  };
});
function Location() {
  const l = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{l.pathname}</output>
      <button
        type="button"
        onClick={() => navigate(`${l.pathname}?tab=overview`)}
      >
        Switch tab externally
      </button>
    </>
  );
}
for (const kind of ["principal", "organization", "missing-metadata"] as const)
  test(`actual detail page preserves pending deletion through ${kind}`, async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let release!: () => void,
      polling = false,
      missing = false,
      organizationId = "org-a";
    const gate = new Promise<void>((r) => (release = r));
    const app = { ...appDeletionFixture("one"), id, organization_id: "org-a" };
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.includes("/jobs/")) {
          polling = true;
          await gate;
          return Response.json({
            success: true,
            data: {
              id: "job-one",
              type: "app_delete",
              status: "completed",
              result: {
                appDeleted: true,
                appId: id,
                deletionJobId: "job-one",
                cleanupConfirmed: true,
              },
            },
          });
        }
        if (init?.method === "DELETE")
          return Response.json(
            {
              success: false,
              state: "pending",
              status: "pending",
              appId: id,
              jobId: "job-one",
            },
            { status: 202 },
          );
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
        if (principal.current.user.id === "user-b" || missing)
          return Response.json(
            { error: "Original metadata unavailable" },
            { status: 404 },
          );
        return Response.json({ app });
      },
    );
    function Surface() {
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/cloud/apps/${id}?tab=settings`]}>
            <CloudI18nProvider initialLang="en">
              <Location />
              <Routes>
                <Route
                  path="/cloud/apps/:id"
                  element={<ApplicationDetailPage />}
                />
                <Route path="/cloud/apps" element={<p>Destination</p>} />
              </Routes>
            </CloudI18nProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    }
    const view = render(<Surface />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete App" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete App",
      }),
    );
    await waitFor(() => expect(polling).toBe(true));
    await user.click(
      screen.getByRole("button", { name: "Switch tab externally" }),
    );
    expect(screen.queryByText("Danger Zone")).not.toBeNull();
    const success = vi.spyOn(toast, "success");
    const invalidation = vi.spyOn(queryClient, "invalidateQueries");
    if (kind === "principal") {
      principal.current = {
        ready: true,
        authenticated: true,
        user: { id: "user-b", email: "b@example.invalid" },
      };
      view.rerender(<Surface />);
      await waitFor(() => expect(screen.queryByText("Danger Zone")).toBeNull());
    } else if (kind === "organization") {
      organizationId = "org-b";
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: [...organizationQueryKeys.user, "auth", "user-a"],
        });
      });
      await waitFor(() => expect(screen.queryByText("Danger Zone")).toBeNull());
    } else {
      missing = true;
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: ["app", id, "auth", "user-a"],
        });
      });
    }
    const before = {
      path: screen.getByTestId("location").textContent,
      settingsPresent: screen.queryByText("Danger Zone") !== null,
    };
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 10));
    });
    if (kind !== "missing-metadata") {
      expect(success).not.toHaveBeenCalled();
      expect(screen.getByTestId("location").textContent).toBe(
        `/cloud/apps/${id}`,
      );
    } else {
      expect(before.settingsPresent).toBe(true);
      expect(success).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("location").textContent).toBe("/cloud/apps");
    }
    expect(
      invalidation.mock.calls.some(
        (call) =>
          call[0]?.queryKey?.length === 1 && call[0].queryKey[0] === "apps",
      ),
    ).toBe(false);
    queryClient.clear();
  });
