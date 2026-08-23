/**
 * Colocated coverage for the Capacitor SQLite facade. Drives the real
 * `openDatabase` / `isSqliteAvailable` / handle methods: off-native refusal,
 * native-plugin registration gating, encryption mapping, `${` interpolation
 * rejection, bound-value copying, execute/query result mapping, and close
 * teardown. The community plugin is faked because Node has no native bridge;
 * the facade under test is not mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => {
  const connection = {
    run: vi.fn(),
    query: vi.fn(),
    close: vi.fn(),
  };
  return {
    createConnection: vi.fn(),
    open: vi.fn(),
    closeConnection: vi.fn(),
    checkConnectionsConsistency: vi.fn(),
    connection,
  };
});

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {
    createConnection: plugin.createConnection,
    open: plugin.open,
    closeConnection: plugin.closeConnection,
    checkConnectionsConsistency: plugin.checkConnectionsConsistency,
  },
}));

import { isSqliteAvailable, openDatabase } from "./capacitor-sqlite.ts";

type CapacitorHost = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
};

const originalGlobalCapacitor = (globalThis as { Capacitor?: unknown })
  .Capacitor;

const INTERPOLATION_ERROR =
  "[capacitor-sqlite] sql must be parameterized — use `values`, not `" +
  "$" +
  "{...}` interpolation";

const UNREGISTERED_ERROR =
  "[capacitor-sqlite] CapacitorSQLite native plugin is not registered";

const INTERPOLATED_ID_SQL = "SELECT * FROM t WHERE id = " + "$" + "{id}";
const INTERPOLATED_NAME_SQL =
  "SELECT * FROM t WHERE name = '" + "$" + "{name}'";

function setCapacitorHost(host: CapacitorHost | null): void {
  const g = globalThis as { Capacitor?: CapacitorHost };
  if (host === null) {
    delete g.Capacitor;
    return;
  }
  g.Capacitor = host;
}

function nativeHost(pluginAvailable = true): CapacitorHost {
  return {
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) =>
      pluginAvailable && name === "CapacitorSQLite",
  };
}

async function openNativeDatabase(opts?: {
  name?: string;
  encryption?: "none" | "encryption" | "secret";
}) {
  setCapacitorHost(nativeHost());
  plugin.createConnection.mockResolvedValue(undefined);
  plugin.open.mockResolvedValue(plugin.connection);
  plugin.connection.close.mockResolvedValue(undefined);
  plugin.closeConnection.mockResolvedValue(undefined);
  return openDatabase({
    name: opts?.name ?? "eliza-state",
    encryption: opts?.encryption,
  });
}

afterEach(() => {
  const g = globalThis as { Capacitor?: unknown };
  if (originalGlobalCapacitor === undefined) {
    delete g.Capacitor;
  } else {
    g.Capacitor = originalGlobalCapacitor;
  }
  plugin.createConnection.mockReset();
  plugin.open.mockReset();
  plugin.closeConnection.mockReset();
  plugin.checkConnectionsConsistency.mockReset();
  plugin.connection.run.mockReset();
  plugin.connection.query.mockReset();
  plugin.connection.close.mockReset();
});

describe("isSqliteAvailable", () => {
  it("returns false in the default off-native Node host", async () => {
    await expect(isSqliteAvailable()).resolves.toBe(false);
    expect(plugin.checkConnectionsConsistency).not.toHaveBeenCalled();
  });

  it("returns false when the host is native but CapacitorSQLite is unavailable", async () => {
    setCapacitorHost(nativeHost(false));
    await expect(isSqliteAvailable()).resolves.toBe(false);
    expect(plugin.checkConnectionsConsistency).not.toHaveBeenCalled();
  });

  it("returns false when the plugin is listed but the platform is not native", async () => {
    const isPluginAvailable = vi.fn(
      (name: string) => name === "CapacitorSQLite",
    );
    setCapacitorHost({
      isNativePlatform: () => false,
      isPluginAvailable,
    });
    await expect(isSqliteAvailable()).resolves.toBe(false);
    expect(isPluginAvailable).not.toHaveBeenCalled();
    expect(plugin.checkConnectionsConsistency).not.toHaveBeenCalled();
  });

  it("returns false when host probe methods are missing", async () => {
    setCapacitorHost({});
    await expect(isSqliteAvailable()).resolves.toBe(false);
    expect(plugin.checkConnectionsConsistency).not.toHaveBeenCalled();
  });

  it("returns true when the native plugin is registered and consistency check resolves", async () => {
    const isPluginAvailable = vi.fn(
      (name: string) => name === "CapacitorSQLite",
    );
    setCapacitorHost({
      isNativePlatform: () => true,
      isPluginAvailable,
    });
    plugin.checkConnectionsConsistency.mockResolvedValue(undefined);

    await expect(isSqliteAvailable()).resolves.toBe(true);

    expect(isPluginAvailable).toHaveBeenCalledWith("CapacitorSQLite");
    expect(plugin.checkConnectionsConsistency).toHaveBeenCalledWith({
      dbNames: [],
      openModes: [],
    });
  });

  it("returns false when the consistency check rejects", async () => {
    setCapacitorHost(nativeHost());
    plugin.checkConnectionsConsistency.mockRejectedValue(
      new Error("native bridge missing"),
    );

    await expect(isSqliteAvailable()).resolves.toBe(false);
  });
});

describe("openDatabase", () => {
  it("throws when the native plugin is not registered and does not open a connection", async () => {
    await expect(openDatabase({ name: "eliza-state" })).rejects.toThrow(
      UNREGISTERED_ERROR,
    );
    expect(plugin.createConnection).not.toHaveBeenCalled();
    expect(plugin.open).not.toHaveBeenCalled();
  });

  it("creates an unencrypted connection by default and returns a named handle", async () => {
    const db = await openNativeDatabase({ name: "agent-kv" });

    expect(db.name).toBe("agent-kv");
    expect(plugin.createConnection).toHaveBeenCalledWith({
      database: "agent-kv",
      version: 1,
      encrypted: false,
      mode: "none",
      readonly: false,
    });
    expect(plugin.open).toHaveBeenCalledWith({
      database: "agent-kv",
      readonly: false,
    });
  });

  it("maps encryption mode 'encryption' to encrypted: true", async () => {
    await openNativeDatabase({ encryption: "encryption" });

    expect(plugin.createConnection).toHaveBeenCalledWith({
      database: "eliza-state",
      version: 1,
      encrypted: true,
      mode: "encryption",
      readonly: false,
    });
  });

  it("maps encryption mode 'secret' to encrypted: true", async () => {
    await openNativeDatabase({ encryption: "secret" });

    expect(plugin.createConnection).toHaveBeenCalledWith({
      database: "eliza-state",
      version: 1,
      encrypted: true,
      mode: "secret",
      readonly: false,
    });
  });

  it("maps explicit encryption mode 'none' to encrypted: false", async () => {
    await openNativeDatabase({ encryption: "none" });

    expect(plugin.createConnection).toHaveBeenCalledWith({
      database: "eliza-state",
      version: 1,
      encrypted: false,
      mode: "none",
      readonly: false,
    });
  });
});

describe("SqliteDatabase execute", () => {
  it("rejects template-interpolation SQL before run is called", async () => {
    const db = await openNativeDatabase();

    await expect(db.execute({ sql: INTERPOLATED_ID_SQL })).rejects.toThrow(
      INTERPOLATION_ERROR,
    );
    expect(plugin.connection.run).not.toHaveBeenCalled();
  });

  it("passes an empty bound-value list when values are omitted", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({ changes: { changes: 0 } });

    await expect(
      db.execute({ sql: "CREATE TABLE t (id INTEGER)" }),
    ).resolves.toEqual({ changes: 0 });
    expect(plugin.connection.run).toHaveBeenCalledWith(
      "CREATE TABLE t (id INTEGER)",
      [],
    );
  });

  it("copies a single bound value so the caller array is not reused", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({
      changes: { changes: 1, lastId: 9 },
    });
    const values: Array<string | number | boolean | null> = ["solo"];

    const result = await db.execute({
      sql: "INSERT INTO t (name) VALUES (?)",
      values,
    });

    expect(result).toEqual({ changes: 1, lastInsertRowId: 9 });
    const passed = plugin.connection.run.mock.calls[0]?.[1];
    expect(passed).toEqual(["solo"]);
    expect(passed).not.toBe(values);
  });

  it("copies a multi-value bound list including null and boolean", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({ changes: { changes: 2 } });
    const values: Array<string | number | boolean | null> = [
      "a",
      1,
      true,
      null,
    ];

    await db.execute({
      sql: "INSERT INTO t (a, b, c, d) VALUES (?, ?, ?, ?)",
      values,
    });

    const passed = plugin.connection.run.mock.calls[0]?.[1];
    expect(passed).toEqual(["a", 1, true, null]);
    expect(passed).not.toBe(values);
  });

  it("treats an empty values array as present and still copies it", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({ changes: { changes: 0 } });
    const values: Array<string | number | boolean | null> = [];

    await db.execute({ sql: "DELETE FROM t WHERE 0", values });

    const passed = plugin.connection.run.mock.calls[0]?.[1];
    expect(passed).toEqual([]);
    expect(passed).not.toBe(values);
  });

  it("defaults missing changes to 0 and omits a non-numeric lastId", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({});

    await expect(db.execute({ sql: "UPDATE t SET x = 1" })).resolves.toEqual({
      changes: 0,
    });
  });

  it("omits lastInsertRowId when lastId is null", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({
      changes: { changes: 1, lastId: null },
    });

    await expect(db.execute({ sql: "UPDATE t SET x = 1" })).resolves.toEqual({
      changes: 1,
    });
  });

  it("includes lastInsertRowId when lastId is 0", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({
      changes: { changes: 1, lastId: 0 },
    });

    await expect(
      db.execute({ sql: "INSERT INTO t (name) VALUES (?)", values: ["z"] }),
    ).resolves.toEqual({ changes: 1, lastInsertRowId: 0 });
  });

  it("allows SQL that contains $ or { separately", async () => {
    const db = await openNativeDatabase();
    plugin.connection.run.mockResolvedValue({ changes: { changes: 0 } });

    await expect(
      db.execute({ sql: "SELECT '$' AS dollar, '{' AS brace" }),
    ).resolves.toEqual({ changes: 0 });
    expect(plugin.connection.run).toHaveBeenCalledTimes(1);
  });
});

describe("SqliteDatabase query", () => {
  it("rejects template-interpolation SQL before query is called", async () => {
    const db = await openNativeDatabase();

    await expect(db.query({ sql: INTERPOLATED_NAME_SQL })).rejects.toThrow(
      INTERPOLATION_ERROR,
    );
    expect(plugin.connection.query).not.toHaveBeenCalled();
  });

  it("returns an empty row list when the plugin omits values", async () => {
    const db = await openNativeDatabase();
    plugin.connection.query.mockResolvedValue({});

    await expect(db.query({ sql: "SELECT * FROM t" })).resolves.toEqual({
      rows: [],
    });
    expect(plugin.connection.query).toHaveBeenCalledWith("SELECT * FROM t", []);
  });

  it("returns a single row when the plugin yields one record", async () => {
    const db = await openNativeDatabase();
    plugin.connection.query.mockResolvedValue({
      values: [{ id: 1, name: "one" }],
    });

    await expect(
      db.query({ sql: "SELECT * FROM t WHERE id = ?", values: [1] }),
    ).resolves.toEqual({ rows: [{ id: 1, name: "one" }] });
  });

  it("returns every row the plugin yields, in order", async () => {
    const db = await openNativeDatabase();
    plugin.connection.query.mockResolvedValue({
      values: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });

    await expect(db.query({ sql: "SELECT id FROM t" })).resolves.toEqual({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });

  it("copies bound query values instead of reusing the caller array", async () => {
    const db = await openNativeDatabase();
    plugin.connection.query.mockResolvedValue({ values: [] });
    const values: Array<string | number | boolean | null> = [42];

    await db.query({ sql: "SELECT * FROM t WHERE id = ?", values });

    const passed = plugin.connection.query.mock.calls[0]?.[1];
    expect(passed).toEqual([42]);
    expect(passed).not.toBe(values);
  });
});

describe("SqliteDatabase close", () => {
  it("closes the connection then the named plugin connection", async () => {
    const db = await openNativeDatabase({ name: "session-db" });
    const order: string[] = [];
    plugin.connection.close.mockImplementation(async () => {
      order.push("connection.close");
    });
    plugin.closeConnection.mockImplementation(async () => {
      order.push("plugin.closeConnection");
    });

    await db.close();

    expect(order).toEqual(["connection.close", "plugin.closeConnection"]);
    expect(plugin.closeConnection).toHaveBeenCalledWith({
      database: "session-db",
      readonly: false,
    });
  });
});
