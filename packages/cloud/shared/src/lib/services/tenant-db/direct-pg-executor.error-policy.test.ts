/**
 * Error-policy guard for DirectPgExecutor (#13415): tenant-DB provisioning must
 * FAIL CLOSED. An internal Postgres failure (connect/query error) must PROPAGATE
 * out of databaseExists/execAdmin — never be swallowed into `false`/success —
 * because SqlTenantDbProvisioner gates `CREATE DATABASE` on databaseExists and a
 * silent `false` would corrupt provisioning. A legitimately-absent database
 * (0 rows) must still resolve to its designed empty result (`false`), distinct
 * from a failure. `pg` is faked (Client) so the real executor logic runs.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let connectShouldThrow: Error | null = null;
let queryImpl: (
  sql: string,
  params?: unknown[],
) => Promise<{ rowCount: number | null; rows: unknown[] }>;
const connectCalls: string[] = [];
const endCalls: number[] = [];

class FakeClient {
  constructor(public readonly config: { connectionString?: string }) {}
  async connect(): Promise<void> {
    connectCalls.push(this.config.connectionString ?? "");
    if (connectShouldThrow) throw connectShouldThrow;
  }
  async query(sql: string, params?: unknown[]) {
    return queryImpl(sql, params);
  }
  async end(): Promise<void> {
    endCalls.push(1);
  }
}

mock.module("pg", () => ({ Client: FakeClient }));

const ADMIN_DSN = "postgres://admin:pw@10.30.1.10:5432/postgres?sslmode=disable";

describe("DirectPgExecutor — fail-closed provisioning (#13415)", () => {
  beforeEach(() => {
    connectShouldThrow = null;
    connectCalls.length = 0;
    endCalls.length = 0;
    queryImpl = async () => ({ rowCount: 0, rows: [] });
  });

  afterEach(() => {
    connectShouldThrow = null;
  });

  it("databaseExists PROPAGATES an internal query failure (not swallowed to false) and still closes the client", async () => {
    const { DirectPgExecutor } = await import("./direct-pg-executor");
    const boom = new Error("connection reset by peer");
    queryImpl = async () => {
      throw boom;
    };

    const exec = new DirectPgExecutor(ADMIN_DSN);
    await expect(exec.databaseExists("tenant_db")).rejects.toThrow("connection reset by peer");
    // finally-block teardown still runs even though the query threw.
    expect(endCalls.length).toBe(1);
  });

  it("databaseExists returns the DESIGNED empty result (false) for a legitimately-absent database", async () => {
    const { DirectPgExecutor } = await import("./direct-pg-executor");
    queryImpl = async () => ({ rowCount: 0, rows: [] });

    const exec = new DirectPgExecutor(ADMIN_DSN);
    await expect(exec.databaseExists("missing_db")).resolves.toBe(false);
    expect(endCalls.length).toBe(1);
  });

  it("databaseExists returns true when the pg_database row is present", async () => {
    const { DirectPgExecutor } = await import("./direct-pg-executor");
    queryImpl = async () => ({ rowCount: 1, rows: [{ "?column?": 1 }] });

    const exec = new DirectPgExecutor(ADMIN_DSN);
    await expect(exec.databaseExists("present_db")).resolves.toBe(true);
  });

  it("databaseExists PROPAGATES a connection failure rather than reporting the db absent", async () => {
    const { DirectPgExecutor } = await import("./direct-pg-executor");
    connectShouldThrow = new Error("ECONNREFUSED 10.30.1.10:5432");

    const exec = new DirectPgExecutor(ADMIN_DSN);
    await expect(exec.databaseExists("tenant_db")).rejects.toThrow("ECONNREFUSED");
    // connect threw before a client existed to end.
    expect(endCalls.length).toBe(0);
  });

  it("execAdmin PROPAGATES a DDL failure (provisioning cannot silently succeed)", async () => {
    const { DirectPgExecutor } = await import("./direct-pg-executor");
    queryImpl = async (sql) => {
      if (sql.includes("CREATE DATABASE")) throw new Error("permission denied to create database");
      return { rowCount: 0, rows: [] };
    };

    const exec = new DirectPgExecutor(ADMIN_DSN);
    await expect(exec.execAdmin(["CREATE DATABASE tenant_db"])).rejects.toThrow(
      "permission denied to create database",
    );
    // client is closed via finally despite the thrown statement.
    expect(endCalls.length).toBe(1);
  });
});
