// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidate } from "../../hooks/resource-cache";
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
  // DatabaseView seeds/reads the module-level resource cache. Clear it so each
  // test starts cold and the status-gates-tables waterfall is exercised cleanly
  // instead of hitting the warm-revisit branch with state leaked from a prior test.
  invalidate("db:status");
  invalidate("db:tables");
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
      expect(screen.getByText("databaseview.DatabaseNotAvailab")).toBeTruthy();
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
      expect(screen.getByText("databaseview.TableIsEmpty")).toBeTruthy();
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
