// @vitest-environment jsdom

/**
 * Apps table bulk delete: selection drives the bulk bar, confirmed deletes are
 * removed from the react-query cache immediately (optimistic — the list API is
 * eventually consistent and a fast refetch can resurrect deleted rows), and a
 * partial failure keeps the failed app while removing the successes.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/apps", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/apps")>();
  return { ...original, deleteApp: vi.fn() };
});
vi.mock("../../shell/CloudI18nProvider", () => ({
  // Minimal interpolating stand-in for the real t(): resolves defaultValue and
  // substitutes {{placeholders}} from the options bag.
  useCloudT:
    () =>
    (
      key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) =>
      (options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(options?.[name] ?? ""),
      ),
}));

import { APPS_QUERY_KEY, type App, deleteApp } from "../lib/apps";
import { AppsTable } from "./apps-table";

const deleteAppMock = vi.mocked(deleteApp);

function makeApp(id: string, name: string): App {
  return {
    id,
    name,
    app_url: `https://apps.test/${id}`,
    website_url: null,
    is_active: true,
    affiliate_code: null,
    total_users: 0,
    total_requests: 0,
    updated_at: "2026-07-04T00:00:00.000Z",
  } as App;
}

const APPS = [
  makeApp("a1", "Alpha"),
  makeApp("a2", "Beta"),
  makeApp("a3", "Gamma"),
];

function renderTable() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(APPS_QUERY_KEY, APPS);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AppsTable apps={APPS} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("AppsTable bulk delete", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("deletes every selected app and drops them from the cache without waiting for a refetch", async () => {
    deleteAppMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const queryClient = renderTable();

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    expect(screen.getByText("2 selected")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Delete selected/ }));
    // Bulk confirm dialog.
    expect(screen.getByText("Delete 2 Apps")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteAppMock).toHaveBeenCalledTimes(2);
    });
    expect(deleteAppMock).toHaveBeenCalledWith("a1");
    expect(deleteAppMock).toHaveBeenCalledWith("a2");
    const cached = queryClient.getQueryData<App[]>(APPS_QUERY_KEY);
    expect(cached?.map((a) => a.id)).toEqual(["a3"]);
  });

  it("keeps a failed delete in the cache and reports it, while successes are removed", async () => {
    deleteAppMock.mockImplementation((id: string) =>
      id === "a2" ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    const user = userEvent.setup();
    const queryClient = renderTable();

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    await user.click(screen.getByRole("button", { name: /Delete selected/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteAppMock).toHaveBeenCalledTimes(2);
    });
    const cached = queryClient.getQueryData<App[]>(APPS_QUERY_KEY);
    expect(cached?.map((a) => a.id)).toEqual(["a2", "a3"]);
  });

  it("deletes a single app from the row action through the same dialog", async () => {
    deleteAppMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const queryClient = renderTable();

    // Row action menus are per-app; open Gamma's and pick Delete.
    const menus = screen.getAllByRole("button", { name: /open actions/i });
    await user.click(menus[menus.length - 1]);
    await user.click(await screen.findByText("Delete App"));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteAppMock).toHaveBeenCalledWith("a3");
    });
    const cached = queryClient.getQueryData<App[]>(APPS_QUERY_KEY);
    expect(cached?.some((a) => a.id === "a3")).toBe(false);
  });
});
