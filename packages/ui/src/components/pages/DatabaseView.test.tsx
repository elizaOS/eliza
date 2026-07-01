// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetResourceCache } from "../../hooks/resource-cache";
import { DatabaseView } from "./DatabaseView";

// DatabaseView talks to the runtime exclusively through the `client` singleton
// re-exported from `../../api`. Mocking that module is the real data seam the
// Q2 data-layer refactor must keep intact.
const clientMock = vi.hoisted(() => ({
  getDatabaseStatus: vi.fn(),
  getDatabaseTables: vi.fn(),
  getDatabaseRows: vi.fn(),
  executeDatabaseQuery: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

// DatabaseView reads only the translator. It now sources `t` from
// useTranslation() (a narrower subscription than useApp()), so mock that to the
// identity translator the assertions expect (keys render verbatim).
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: (k: string) => k, uiLanguage: "en" }),
}));

const connectedStatus = {
  provider: "pglite",
  connected: true,
  serverVersion: "16.0",
  tableCount: 2,
  pgliteDataDir: "/tmp/db",
  postgresHost: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clientMock.getDatabaseStatus.mockReset();
  clientMock.getDatabaseTables.mockReset();
  clientMock.getDatabaseRows.mockReset();
  clientMock.executeDatabaseQuery.mockReset();
  // DatabaseView seeds/reads the module-level resource cache (db:status,
  // db:tables). Fully reset it — including inflight requests and request
  // sequence — so each test starts cold and the status-gates-tables waterfall
  // is exercised cleanly instead of hitting a warm branch with state leaked
  // from a prior test (or a prior test file in the same worker).
  __resetResourceCache();
});

afterEach(() => cleanup());

describe("DatabaseView", () => {
  it("shows a connecting state, then loads the table list once status resolves", async () => {
    const status = deferred<typeof connectedStatus>();
    clientMock.getDatabaseStatus.mockReturnValue(status.promise);
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [
        { name: "memories", rowCount: 42, columns: [{ name: "id" }] },
        { name: "entities", rowCount: 7, columns: [{ name: "id" }] },
      ],
    });

    render(<DatabaseView />);

    // Pending status → connecting indicator (data not yet resolved).
    expect(screen.getByText("game.connecting")).toBeTruthy();

    status.resolve(connectedStatus);

    // Once status + tables resolve, the table rows render.
    await waitFor(() => {
      expect(screen.getByText("memories")).toBeTruthy();
    });
    expect(screen.getByText("entities")).toBeTruthy();
    expect(clientMock.getDatabaseTables).toHaveBeenCalled();
  });

  it("renders the database-unavailable message when status reports disconnected", async () => {
    clientMock.getDatabaseStatus.mockResolvedValue({
      ...connectedStatus,
      connected: false,
      tableCount: 0,
    });

    render(<DatabaseView />);

    await waitFor(() => {
      expect(
        screen.getByText("databaseview.StartAgentToUseDatabase"),
      ).toBeTruthy();
    });
    // Disconnected status must NOT trigger a table fetch.
    expect(clientMock.getDatabaseTables).not.toHaveBeenCalled();
  });

  it("surfaces a status-load error message to the user when getDatabaseStatus rejects", async () => {
    clientMock.getDatabaseStatus.mockRejectedValue(
      new Error("boom: cannot reach db"),
    );

    render(<DatabaseView />);

    // The catch branch records statusLoadError and renders the disconnected
    // panel with the concrete failure message — error surfaced, not swallowed.
    await waitFor(() => {
      expect(screen.getByText("boom: cannot reach db")).toBeTruthy();
    });
    expect(clientMock.getDatabaseTables).not.toHaveBeenCalled();
  });

  it("loads rows when a table is selected and renders them in the grid", async () => {
    clientMock.getDatabaseStatus.mockResolvedValue(connectedStatus);
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [
        {
          name: "memories",
          rowCount: 1,
          columns: [
            { name: "id", type: "text" },
            { name: "content", type: "text" },
          ],
        },
      ],
    });
    clientMock.getDatabaseRows.mockResolvedValue({
      columns: ["id", "content"],
      rows: [{ id: "row-1", content: "hello world" }],
      total: 1,
    });

    render(<DatabaseView />);

    const tableButton = await screen.findByText("memories");
    fireEvent.click(tableButton);

    await waitFor(() => {
      expect(clientMock.getDatabaseRows).toHaveBeenCalledWith(
        "memories",
        expect.objectContaining({ limit: 50, offset: 0 }),
      );
    });
    // The fetched cell value renders in the results grid.
    await waitFor(() => {
      expect(screen.getByText("hello world")).toBeTruthy();
    });
  });

  it("renders the empty-table state when a selected table returns zero rows", async () => {
    clientMock.getDatabaseStatus.mockResolvedValue(connectedStatus);
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [{ name: "empty_tbl", rowCount: 0, columns: [{ name: "id" }] }],
    });
    clientMock.getDatabaseRows.mockResolvedValue({
      columns: ["id"],
      rows: [],
      total: 0,
    });

    render(<DatabaseView />);

    fireEvent.click(await screen.findByText("empty_tbl"));

    await waitFor(() => {
      expect(screen.getByText("databaseview.NoDataInsertViaSql")).toBeTruthy();
    });
  });

  // A row-fetch rejection must surface to the user. Previously the error was
  // swallowed: loadTableData's catch set errorMessage, but the init effect
  // (depending on the unstable `t` from useApp) re-ran on every render and
  // called loadTables → setErrorMessage(""), wiping it before paint. The Q2
  // fix reads `t`/`tables` through refs so the loaders are stable and the
  // banner persists.
  it("surfaces a row-load error to the user when getDatabaseRows rejects", async () => {
    clientMock.getDatabaseStatus.mockResolvedValue(connectedStatus);
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [
        {
          name: "memories",
          rowCount: 1,
          columns: [{ name: "id", type: "text" }],
        },
      ],
    });
    clientMock.getDatabaseRows.mockRejectedValue(new Error("row fetch failed"));

    render(<DatabaseView />);

    fireEvent.click(await screen.findByText("memories"));

    await waitFor(() => {
      expect(clientMock.getDatabaseRows).toHaveBeenCalled();
    });

    // Desired: an error banner with the failure key is shown to the user.
    await waitFor(
      () => {
        expect(
          screen.getByText((content) =>
            content.includes("databaseview.FailedToLoadTable"),
          ),
        ).toBeTruthy();
      },
      { timeout: 1000 },
    );
  });
});

// ── SQL editor mode ──────────────────────────────────────────────────────────
// The other data seam: `client.executeDatabaseQuery(sql)`. These drive the real
// SqlEditorPanel (not mocked) through the DatabaseView state — type → run →
// render/route the QueryResult. `t` resolves to the identity translator (the
// test-fallback proxy in app-store for components reading useAppSelector, and
// the mocked useTranslation for DatabaseView itself), so labels render as keys.
describe("DatabaseView SQL query mode", () => {
  // Switch the editor SegmentedControl to the SQL editor. There is no leftNav,
  // so DatabaseView renders exactly one view-mode toggle in the header. Wait for
  // the initial status→tables load to settle first: loadTables clears
  // errorMessage synchronously on invocation, and if it lands AFTER a query it
  // would wipe a freshly-set error banner (a real ordering hazard).
  async function enterSqlMode() {
    await waitFor(() =>
      expect(clientMock.getDatabaseTables).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByText("databaseview.SQLEditor"));
  }

  function sqlTextarea(): HTMLTextAreaElement {
    // SqlEditorPanel renders a single <textarea> for the query.
    const el = document.querySelector("textarea");
    if (!el) throw new Error("no SQL textarea rendered");
    return el as HTMLTextAreaElement;
  }

  function runButton(): HTMLButtonElement {
    // Idle label is the runQuery key; while loading it becomes common.running.
    const el =
      (screen.queryByText("databaseview.runQuery") ??
        screen.queryByText("common.running"))?.closest("button") ?? null;
    if (!el) throw new Error("no Run Query button");
    return el as HTMLButtonElement;
  }

  beforeEach(() => {
    clientMock.getDatabaseStatus.mockResolvedValue(connectedStatus);
    clientMock.getDatabaseTables.mockResolvedValue({ tables: [] });
  });

  it("sends the exact query text to executeDatabaseQuery and renders the returned rows", async () => {
    clientMock.executeDatabaseQuery.mockResolvedValue({
      columns: ["cnt"],
      rows: [{ cnt: 42 }],
      rowCount: 1,
      durationMs: 12,
    });

    render(<DatabaseView />);
    await enterSqlMode();

    fireEvent.change(sqlTextarea(), {
      target: { value: "SELECT count(*) AS cnt FROM memories" },
    });
    fireEvent.click(runButton());

    // The typed SQL is forwarded verbatim — not trimmed, mangled, or defaulted.
    await waitFor(() => {
      expect(clientMock.executeDatabaseQuery).toHaveBeenCalledWith(
        "SELECT count(*) AS cnt FROM memories",
      );
    });
    // The result grid paints the returned cell, and the footer shows the
    // reported duration — proving the QueryResult round-trips into the UI.
    await waitFor(() => {
      expect(screen.getByText("42")).toBeTruthy();
    });
    expect(screen.getByText("12ms")).toBeTruthy();
  });

  it("surfaces an error banner (no crash) when executeDatabaseQuery rejects", async () => {
    clientMock.executeDatabaseQuery.mockRejectedValue(
      new Error("syntax error near DROP"),
    );

    render(<DatabaseView />);
    await enterSqlMode();

    fireEvent.change(sqlTextarea(), { target: { value: "DROP TABLE memories" } });
    fireEvent.click(runButton());

    await waitFor(() => {
      expect(clientMock.executeDatabaseQuery).toHaveBeenCalledWith(
        "DROP TABLE memories",
      );
    });
    // The failure is shown to the user, not swallowed…
    await waitFor(() => {
      expect(
        screen.getByText((c) => c.includes("databaseview.QueryFailed")),
      ).toBeTruthy();
    });
    // …and the editor is still mounted (the reject did not blow up the view).
    expect(document.querySelector("textarea")).toBeTruthy();
    // NOTE: there is NO client-side confirmation gate for destructive SQL — a
    // DROP is forwarded exactly like any other statement. This asserts the
    // real (ungated) behavior; if a gate is ever added it must update this.
    expect(clientMock.executeDatabaseQuery).toHaveBeenCalledTimes(1);
  });

  it("shows the empty-result state when the query returns zero rows", async () => {
    clientMock.executeDatabaseQuery.mockResolvedValue({
      columns: ["id"],
      rows: [],
      rowCount: 0,
      durationMs: 3,
    });

    render(<DatabaseView />);
    await enterSqlMode();

    fireEvent.change(sqlTextarea(), {
      target: { value: "SELECT * FROM memories WHERE 1=0" },
    });
    fireEvent.click(runButton());

    await waitFor(() => {
      expect(clientMock.executeDatabaseQuery).toHaveBeenCalledTimes(1);
    });
    // Zero-row results route to the dedicated empty state, not the grid.
    await waitFor(() => {
      expect(screen.getByText("databaseview.QueryReturnedNoRo")).toBeTruthy();
    });
  });

  it("does not fire a query for whitespace-only input (guard + disabled button)", async () => {
    render(<DatabaseView />);
    await enterSqlMode();

    // Whitespace never trims to a statement: button stays disabled…
    fireEvent.change(sqlTextarea(), { target: { value: "   \n  " } });
    expect(runButton().disabled).toBe(true);

    // …and the Cmd/Ctrl+Enter shortcut path (which bypasses the disabled attr)
    // still no-ops via runQuery's own !queryText.trim() guard.
    fireEvent.keyDown(sqlTextarea(), {
      key: "Enter",
      ctrlKey: true,
    });
    // A real statement flips the button live.
    fireEvent.change(sqlTextarea(), { target: { value: "SELECT 1" } });
    expect(runButton().disabled).toBe(false);

    expect(clientMock.executeDatabaseQuery).not.toHaveBeenCalled();
  });

  it("is idempotent under a double-click while a query is in flight", async () => {
    const pending = deferred<{
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      durationMs: number;
    }>();
    clientMock.executeDatabaseQuery.mockReturnValue(pending.promise);

    render(<DatabaseView />);
    await enterSqlMode();

    fireEvent.change(sqlTextarea(), { target: { value: "SELECT 1" } });
    fireEvent.click(runButton());
    // While the first request is pending the button is disabled (loading), so a
    // rapid second click cannot enqueue a duplicate execution.
    await waitFor(() => {
      expect(runButton().disabled).toBe(true);
    });
    fireEvent.click(runButton());

    expect(clientMock.executeDatabaseQuery).toHaveBeenCalledTimes(1);

    pending.resolve({
      columns: ["x"],
      rows: [{ x: "flight-done" }],
      rowCount: 1,
      durationMs: 1,
    });
    await waitFor(() => {
      expect(screen.getByText("flight-done")).toBeTruthy();
    });
  });
});

// ── Table-browse pagination ──────────────────────────────────────────────────
describe("DatabaseView pagination", () => {
  beforeEach(() => {
    clientMock.getDatabaseStatus.mockResolvedValue(connectedStatus);
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [
        {
          name: "memories",
          rowCount: 120,
          columns: [{ name: "id", type: "text" }],
        },
      ],
    });
    // Echo the requested offset back so each page is visually distinguishable
    // and the paging math (offset in → rows out) is observable in the DOM.
    clientMock.getDatabaseRows.mockImplementation(
      (name: string, opts: { offset?: number }) =>
        Promise.resolve({
          table: name,
          columns: ["id"],
          rows: [{ id: `off-${opts.offset ?? 0}` }],
          total: 120,
          offset: opts.offset ?? 0,
          limit: 50,
        }),
    );
  });

  it("pages forward/back by the row limit and clamps Prev at offset 0", async () => {
    render(<DatabaseView />);

    fireEvent.click(await screen.findByText("memories"));

    // First page: offset 0. Prev is disabled at the start of the range.
    await waitFor(() => {
      expect(screen.getByText("off-0")).toBeTruthy();
    });
    expect(clientMock.getDatabaseRows).toHaveBeenLastCalledWith(
      "memories",
      expect.objectContaining({ offset: 0, limit: 50 }),
    );
    const prev = () =>
      screen.getByText("common.prev").closest("button") as HTMLButtonElement;
    const next = () =>
      screen.getByText("common.next").closest("button") as HTMLButtonElement;
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);

    // Next → offset advances by the ROW_LIMIT (50), refetching that page.
    fireEvent.click(next());
    await waitFor(() => {
      expect(screen.getByText("off-50")).toBeTruthy();
    });
    expect(clientMock.getDatabaseRows).toHaveBeenLastCalledWith(
      "memories",
      expect.objectContaining({ offset: 50 }),
    );
    expect(prev().disabled).toBe(false);

    // Prev → back to offset 0 (never negative).
    fireEvent.click(prev());
    await waitFor(() => {
      expect(screen.getByText("off-0")).toBeTruthy();
    });
    expect(clientMock.getDatabaseRows).toHaveBeenLastCalledWith(
      "memories",
      expect.objectContaining({ offset: 0 }),
    );
  });
});
