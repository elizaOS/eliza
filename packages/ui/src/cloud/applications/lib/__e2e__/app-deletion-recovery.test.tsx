// @vitest-environment jsdom
/** Actual pages/client retain original jobs across failed observations. */
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
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
import ApplicationsPage from "../../ApplicationsPage";
import { appDeletionFixture } from "./app-deletion-fixture";
const id = "db658ce3-a7d8-4dc4-9b8e-65c1bbce2001";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
for (const surface of ["detail", "table"] as const)
  for (const mode of [
    "transport",
    "unconfirmed",
    "recovery",
    "admission",
  ] as const) {
    test(
      mode === "admission"
        ? `${surface} keeps ordinary admission rejection separate from pending jobs`
        : `${surface} retains the original deletion after ${mode} and resumes with GET only`,
      async () => {
        const app = {
          ...appDeletionFixture("one"),
          id,
          organization_id: "org-a",
        };
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        let complete = false,
          admitted = false;
        const calls: Array<{ path: string; method: string }> = [];
        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input);
            calls.push({ path, method: init?.method ?? "GET" });
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
              return Response.json({ apps: admitted ? [] : [app] });
            if (init?.method === "DELETE") {
              if (mode === "admission")
                return Response.json(
                  { error: "controlled admission rejection" },
                  { status: 400 },
                );
              admitted = true;
              return Response.json(
                {
                  success: false,
                  state: "pending",
                  status: "pending",
                  appId: id,
                  jobId: "original-job",
                },
                { status: 202 },
              );
            }
            if (path.includes("/jobs/")) {
              if (!complete && mode === "transport")
                throw new TypeError("controlled status read failure");
              return Response.json({
                success: true,
                data: {
                  id: "original-job",
                  type: "app_delete",
                  status:
                    !complete && mode === "recovery" ? "failed" : "completed",
                  result: {
                    appDeleted: true,
                    appId: id,
                    deletionJobId: "original-job",
                    cleanupConfirmed: complete,
                  },
                },
              });
            }
            return admitted
              ? Response.json(
                  { error: "Original metadata unavailable" },
                  { status: 404 },
                )
              : Response.json({ app });
          },
        );
        const success = vi.spyOn(toast, "success"),
          failure = vi.spyOn(toast, "error");
        render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter
              initialEntries={[
                surface === "detail"
                  ? `/cloud/apps/${id}?tab=settings`
                  : "/cloud/apps",
              ]}
            >
              <CloudI18nProvider initialLang="en">
                <Location />
                <Routes>
                  <Route
                    path="/cloud/apps/:id"
                    element={<ApplicationDetailPage />}
                  />
                  <Route path="/cloud/apps" element={<ApplicationsPage />} />
                </Routes>
              </CloudI18nProvider>
            </MemoryRouter>
          </QueryClientProvider>,
        );
        const user = userEvent.setup();
        if (surface === "table") {
          await user.click(
            await screen.findByRole("button", { name: "Open actions" }),
          );
          await user.click(
            screen.getByRole("menuitem", { name: "Delete App" }),
          );
        } else
          await user.click(
            await screen.findByRole("button", { name: "Delete App" }),
          );
        await user.click(
          within(screen.getByRole("alertdialog")).getByRole("button", {
            name: surface === "table" ? "Delete" : "Delete App",
          }),
        );
        if (mode === "admission") {
          await waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
          expect(success).not.toHaveBeenCalled();
          expect(
            screen.queryByRole("button", { name: "Check deletion status" }),
          ).toBeNull();
          expect(
            calls.filter((call) => call.path.includes("/jobs/")),
          ).toHaveLength(0);
          if (surface === "detail")
            expect(
              screen
                .getByRole("button", { name: "Delete App" })
                .hasAttribute("disabled"),
            ).toBe(false);
          else expect(screen.queryByText("Deleting…")).toBeNull();
          queryClient.clear();
          return;
        }
        const resume = await screen.findByRole("button", {
          name: "Check deletion status",
        });
        expect(success).not.toHaveBeenCalled();
        expect(failure).not.toHaveBeenCalled();
        if (mode === "recovery")
          expect(screen.getByText(/requires recovery/)).toBeTruthy();
        else expect(screen.getByText(/still pending/)).toBeTruthy();
        await act(async () => {
          await queryClient.invalidateQueries({
            queryKey: surface === "table" ? ["apps"] : ["app", id],
          });
        });
        expect(
          screen.getByRole("button", { name: "Check deletion status" }),
        ).toBeTruthy();
        if (surface === "table")
          expect(screen.getByText("Deleting…")).toBeTruthy();
        else
          expect(
            screen
              .getByRole("button", { name: "Save Changes" })
              .hasAttribute("disabled"),
          ).toBe(true);
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          1,
        );
        complete = true;
        await user.click(resume);
        await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
        await screen.findByText("No apps yet");
        expect(screen.getByTestId("location").textContent).toBe("/cloud/apps");
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          1,
        );
        expect(
          calls
            .filter((call) => call.path.includes("/jobs/"))
            .map((call) => call.method),
        ).toEqual(["GET", "GET"]);
        queryClient.clear();
      },
    );
  }
