// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  // DOCUMENTS DESIRED-NOT-YET BEHAVIOR (uses `it.fails`).
  //
  // When getDatabaseRows rejects, loadTableData's catch calls
  // `setErrorMessage(t("databaseview.FailedToLoadTable", …))`, yet the rejected
  // row fetch is currently swallowed: no error banner renders and the view
  // falls back to the "Select a table" placeholder. This `it.fails` test will
  // PASS today (the assertion below throws because the error never surfaces)
  // and will start FAILING — alerting us — the moment the Q2 refactor wires the
  // error through to the user. At that point, delete the `.fails` modifier.
  it.fails(
    "should surface a row-load error to the user when getDatabaseRows rejects (currently swallowed)",
    async () => {
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
      clientMock.getDatabaseRows.mockRejectedValue(
        new Error("row fetch failed"),
      );

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
    },
  );
});
