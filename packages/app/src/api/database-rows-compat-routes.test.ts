import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const { executeRawSql, ensureOwner } = vi.hoisted(() => ({
  executeRawSql: vi.fn(),
  ensureOwner: vi.fn(async () => true),
}));
vi.mock("@elizaos/plugin-sql", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeRawSql,
}));
vi.mock("./auth.ts", () => ({ ensureRouteMinRole: ensureOwner }));
vi.mock("./compat-route-shared", () => ({
  DATABASE_UNAVAILABLE_MESSAGE: "Database unavailable",
}));

import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";

let table = 0;
function request() {
  return {
    method: "GET",
    url: `/api/database/tables/test_${table++}/rows?schema=public`,
  } as http.IncomingMessage;
}
function response() {
  return {
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
}
const state: CompatRuntimeState = {
  // The SQL boundary is mocked; this test needs only a present runtime.
  current: {} as NonNullable<CompatRuntimeState["current"]>,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  ensureOwner.mockResolvedValue(true);
  executeRawSql.mockReset();
  executeRawSql.mockResolvedValueOnce({ rows: [{ column_name: "id" }] });
});

describe("database row count boundary", () => {
  it.each([
    null,
    undefined,
    "",
    " ",
    false,
    true,
    [],
    -1,
    1.5,
    "1e2",
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects malformed count %j before reading or returning rows",
    async (total) => {
      executeRawSql.mockResolvedValueOnce({ rows: [{ total }] });
      const res = response();
      await expect(
        handleDatabaseRowsCompatRoute(request(), res, state),
      ).rejects.toMatchObject({ code: "DB_COUNT_UNAVAILABLE" });
      expect(executeRawSql).toHaveBeenCalledTimes(2);
      expect(res.end).not.toHaveBeenCalled();
    },
  );

  it.each([0, "0", 42, "42"])("returns valid count %j", async (total) => {
    executeRawSql.mockResolvedValueOnce({ rows: [{ total }] });
    executeRawSql.mockResolvedValueOnce({ rows: [] });
    const res = response();
    expect(await handleDatabaseRowsCompatRoute(request(), res, state)).toBe(
      true,
    );
    expect(
      JSON.parse(vi.mocked(res.end).mock.calls[0][0] as string).total,
    ).toBe(Number(total));
  });

  it("performs no database access when owner authorization fails", async () => {
    ensureOwner.mockResolvedValue(false);
    expect(
      await handleDatabaseRowsCompatRoute(request(), response(), state),
    ).toBe(true);
    expect(executeRawSql).not.toHaveBeenCalled();
  });
});
