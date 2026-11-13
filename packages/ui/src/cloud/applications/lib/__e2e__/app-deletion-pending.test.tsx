// @vitest-environment jsdom
/** Real table/query-cache/client flow; local HTTP controls only completion. */
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { CloudI18nProvider } from "../../../shell/CloudI18nProvider";
import { AppSettings } from "../../components/app-settings";
import { AppsTable } from "../../components/apps-table";
import { toast } from "../../../../bridge/toast";
import { APPS_QUERY_KEY, type App } from "../apps";
import { appDeletionFixture as fixture } from "./app-deletion-fixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

test("bulk deleting rows stay visible with pending status and disabled mutations until exact HTTP receipts complete", async () => {
  const apps = ["one", "two"].map(fixture);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(APPS_QUERY_KEY, apps);
  let complete = false;
  const gates: Array<() => void> = [];
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const id = path.split("/").at(-1)!;
      if (init?.method === "DELETE")
        return Response.json(
          {
            success: false,
            state: "pending",
            status: "pending",
            appId: id,
            jobId: `job-${id}`,
          },
          { status: 202 },
        );
      if (!complete) await new Promise<void>((resolve) => gates.push(resolve));
      return Response.json({
        success: true,
        data: {
          id,
          type: "app_delete",
          status: "completed",
          result: {
            appDeleted: true,
            appId: id.replace("job-", ""),
            deletionJobId: id,
            cleanupConfirmed: true,
          },
        },
      });
    },
  );
  function Rows() {
    const { data = [] } = useQuery<App[]>({
      queryKey: APPS_QUERY_KEY,
      queryFn: async () => apps,
      enabled: false,
    });
    return <AppsTable apps={data} queryKey={APPS_QUERY_KEY} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CloudI18nProvider initialLang="en">
          <Rows />
        </CloudI18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Select App one" }));
  await user.click(screen.getByRole("checkbox", { name: "Select App two" }));
  await user.click(screen.getByRole("button", { name: "Delete selected" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(screen.getAllByText("Deleting…")).toHaveLength(2));
  expect(
    screen
      .getByRole("checkbox", { name: "Select App one" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("checkbox", { name: "Select App two" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByRole("link", { name: "App one" })).toBeNull();
  expect(screen.queryByRole("link", { name: "App two" })).toBeNull();
  expect(queryClient.getQueryData<App[]>(APPS_QUERY_KEY)).toHaveLength(2);
  await user.click(screen.getAllByRole("button", { name: "Open actions" })[0]!);
  expect(
    screen
      .getByRole("menuitem", { name: "Manage App" })
      .hasAttribute("data-disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("menuitem", { name: "Delete App" })
      .hasAttribute("data-disabled"),
  ).toBe(true);
  expect(calls.filter((value) => value.startsWith("DELETE "))).toHaveLength(2);
  await act(async () => {
    complete = true;
    for (const release of gates) release();
  });
  await waitFor(() =>
    expect(queryClient.getQueryData<App[]>(APPS_QUERY_KEY)).toHaveLength(0),
  );
  expect(screen.queryByText("App one")).toBeNull();
  expect(screen.queryByText("App two")).toBeNull();
  expect(calls.filter((value) => value.startsWith("DELETE "))).toHaveLength(2);
  queryClient.clear();
});

test("settings disable save and key regeneration while the original deletion receipt is pending", async () => {
  const app = fixture("one");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
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
          <AppSettings app={app} appsQueryKey={APPS_QUERY_KEY} />
        </CloudI18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete App",
    }),
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(
    screen
      .getByRole("button", { name: "Save Changes" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Regenerate" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await user.click(screen.getByRole("button", { name: "Regenerate" }));
  expect(calls).toHaveLength(2);
  await act(async () => {
    release();
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save Changes" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  queryClient.clear();
});

test("a second row cannot replace an active deletion batch and duplicate confirmation sends only one request", async () => {
  const apps = ["one", "two"].map(fixture);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(APPS_QUERY_KEY, apps);
  const gates = new Map<string, () => void>();
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const id = String(input).split("/").at(-1)!;
      calls.push(`${init?.method ?? "GET"} ${id}`);
      if (init?.method === "DELETE")
        return Response.json(
          {
            success: false,
            state: "pending",
            status: "pending",
            appId: id,
            jobId: `job-${id}`,
          },
          { status: 202 },
        );
      await new Promise<void>((resolve) => gates.set(id, resolve));
      return Response.json({
        success: true,
        data: {
          id,
          type: "app_delete",
          status: "completed",
          result: {
            appDeleted: true,
            appId: id.replace("job-", ""),
            deletionJobId: id,
            cleanupConfirmed: true,
          },
        },
      });
    },
  );
  function Rows() {
    const { data = [] } = useQuery<App[]>({
      queryKey: APPS_QUERY_KEY,
      queryFn: async () => apps,
      enabled: false,
    });
    return <AppsTable apps={data} queryKey={APPS_QUERY_KEY} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CloudI18nProvider initialLang="en">
          <Rows />
        </CloudI18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "Open actions" })[0]!);
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  const confirm = within(screen.getByRole("alertdialog")).getByRole("button", {
    name: "Delete",
  });
  await act(async () => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  await waitFor(() => expect(gates.has("job-one")).toBe(true));
  expect(calls.filter((value) => value.startsWith("DELETE "))).toEqual([
    "DELETE one",
  ]);
  expect(screen.getAllByText("Deleting…")).toHaveLength(1);
  await user.click(screen.getAllByRole("button", { name: "Open actions" })[1]!);
  const other = screen.getByRole("menuitem", { name: "Delete App" });
  expect(other.hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(other);
  expect(calls.filter((value) => value.startsWith("DELETE "))).toHaveLength(1);
  await user.keyboard("{Escape}");
  await act(async () => {
    gates.get("job-one")!();
  });
  await waitFor(() =>
    expect(queryClient.getQueryData<App[]>(APPS_QUERY_KEY)).toHaveLength(1),
  );
  expect(screen.queryByText("App one")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  expect(
    screen
      .getByRole("menuitem", { name: "Delete App" })
      .hasAttribute("data-disabled"),
  ).toBe(false);
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(gates.has("job-two")).toBe(true));
  expect(screen.getAllByText("Deleting…")).toHaveLength(1);
  expect(calls.filter((value) => value.startsWith("DELETE "))).toEqual([
    "DELETE one",
    "DELETE two",
  ]);
  await act(async () => {
    gates.get("job-two")!();
  });
  await waitFor(() =>
    expect(queryClient.getQueryData<App[]>(APPS_QUERY_KEY)).toHaveLength(0),
  );
  queryClient.clear();
});

test("a list refetch cannot hide pending cleanup rows before their original receipt", async () => {
  const apps = [fixture("one")];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(APPS_QUERY_KEY, apps);
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  let polling = false;
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
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
  function Rows() {
    const { data = [] } = useQuery<App[]>({
      queryKey: APPS_QUERY_KEY,
      queryFn: async () => apps,
      enabled: false,
    });
    return (
      <AppsTable apps={data} queryKey={APPS_QUERY_KEY}>
        {data.length === 0 ? <p>No apps remaining</p> : undefined}
      </AppsTable>
    );
  }
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CloudI18nProvider initialLang="en">
          <Rows />
        </CloudI18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(polling).toBe(true));
  try {
    await act(async () => {
      queryClient.setQueryData(APPS_QUERY_KEY, []);
    });
    expect(screen.getByText("App one")).toBeTruthy();
    expect(screen.getByText("Deleting…")).toBeTruthy();
    expect(screen.queryByText("No apps remaining")).toBeNull();
  } finally {
    await act(async () => {
      release();
    });
  }
  await waitFor(() =>
    expect(screen.getByText("No apps remaining")).toBeTruthy(),
  );
  queryClient.clear();
});

test("a late deletion receipt after an authority switch cannot publish into the next session", async () => {
  const oldKey = [...APPS_QUERY_KEY, "auth", "user-a"];
  const newKey = [...APPS_QUERY_KEY, "auth", "user-b"];
  const oldApp = fixture("one");
  const newApp = { ...fixture("two"), organization_id: "other-org" };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(oldKey, [oldApp]);
  queryClient.setQueryData(newKey, [newApp]);
  const success = vi.spyOn(toast, "success");
  let release!: () => void,
    polling = false;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
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
  function Owner({ second = false }: { second?: boolean }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CloudI18nProvider initialLang="en">
            <AppsTable
              key={second ? "user-b:other-org" : "user-a:org"}
              queryKey={second ? newKey : oldKey}
              apps={second ? [newApp] : [oldApp]}
            />
          </CloudI18nProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  const view = render(<Owner />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(polling).toBe(true));
  view.rerender(<Owner second />);
  expect(screen.queryByText("App one")).toBeNull();
  expect(screen.getByText("App two")).toBeTruthy();
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(success).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(newKey)).toEqual([newApp]);
  expect(queryClient.getQueryData(oldKey)).toEqual([oldApp]);
  queryClient.clear();
});

test("a completed batch cannot run its delayed cache refresh after an authority change", async () => {
  const oldKey = [...APPS_QUERY_KEY, "auth", "old-user"];
  const newKey = [...APPS_QUERY_KEY, "auth", "new-user"];
  const app = fixture("one"),
    other = { ...fixture("two"), organization_id: "other-org" };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(oldKey, [app]);
  queryClient.setQueryData(newKey, [other]);
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE"
        ? Response.json(
            {
              success: false,
              state: "pending",
              status: "pending",
              appId: "one",
              jobId: "job-one",
            },
            { status: 202 },
          )
        : Response.json({
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
          }),
  );
  function Owner({ next = false }: { next?: boolean }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CloudI18nProvider initialLang="en">
            <AppsTable
              key={next ? "new-user:other-org" : "old-user:org"}
              queryKey={next ? newKey : oldKey}
              apps={next ? [other] : [app]}
            />
          </CloudI18nProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  const view = render(<Owner />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete App" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(queryClient.getQueryData(oldKey)).toEqual([]));
  const invalidation = vi.spyOn(queryClient, "invalidateQueries");
  view.rerender(<Owner next />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8200));
  });
  expect(invalidation).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(newKey)).toEqual([other]);
  queryClient.clear();
}, 15000);
