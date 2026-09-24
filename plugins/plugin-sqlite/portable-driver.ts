/** Runs real SQLite compiled to JavaScript for Workers without native SQLite bindings. */
import { ElizaError } from "@elizaos/core";
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { SqlDatabase, SQLiteDriver, SqlRow, SqlValue } from "./sqlite-driver-types";

function bindValue(value: SqlValue): Exclude<SqlValue, bigint> {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new ElizaError("Portable SQLite integer exceeds the safe binding range", {
      code: "SQLITE_INTEGER_OUT_OF_RANGE",
    });
  }
  return number;
}

export const portableSQLiteDriver: SQLiteDriver = {
  supportsFileSystem: false,
  assertSupportedRuntime() {},
  async open(path: string): Promise<SqlDatabase> {
    if (path !== ":memory:") {
      throw new ElizaError("Portable SQLite requires an isolated :memory: database", {
        code: "SQLITE_PORTABLE_PATH_UNSUPPORTED",
      });
    }
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    return {
      exec(sql) { database.exec(sql); },
      prepare(sql) {
        const rows = (values: SqlValue[], first: boolean): SqlRow[] => {
          const statement = database.prepare(sql);
          try {
            statement.bind(values.map(bindValue));
            const result: SqlRow[] = [];
            while (statement.step()) {
              result.push(statement.getAsObject());
              if (first) break;
            }
            return result;
          } finally {
            statement.free();
          }
        };
        return {
          get: (...values) => rows(values, true)[0],
          all: (...values) => rows(values, false),
          run: (...values) => {
            rows(values, false);
            return { changes: database.getRowsModified() };
          },
        };
      },
      close() { database.close(); },
    };
  },
};
