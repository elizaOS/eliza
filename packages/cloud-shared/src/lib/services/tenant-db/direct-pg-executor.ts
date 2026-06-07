/**
 * DirectPgExecutor (Apps / Product 2) — the real {@link TenantDbSqlExecutor}
 * backend for a self-managed Postgres cluster. Connects with the cluster's
 * admin DSN (node-postgres) and runs provisioning DDL one statement at a time
 * in autocommit (CREATE DATABASE cannot run inside a transaction).
 *
 * This is the IO adapter behind the pure provisioner (U2): the DDL/DSN strings
 * are built + unit-tested there; this just executes them. Its behavior is
 * validated against a real Postgres (integration), not mocked.
 */

import { Client } from "pg";
import type { TenantDbSqlExecutor } from "./tenant-db-provisioner";

export class DirectPgExecutor implements TenantDbSqlExecutor {
  private readonly adminDsn: string;

  /** @param adminDsn admin connection to the cluster's maintenance database. */
  constructor(adminDsn: string) {
    this.adminDsn = adminDsn;
  }

  private async run(connectionString: string, statements: readonly string[]): Promise<void> {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      for (const sql of statements) {
        await client.query(sql);
      }
    } finally {
      await client.end();
    }
  }

  async execAdmin(statements: readonly string[]): Promise<void> {
    await this.run(this.adminDsn, statements);
  }

  async execInDatabase(dbName: string, statements: readonly string[]): Promise<void> {
    const url = new URL(this.adminDsn);
    url.pathname = `/${encodeURIComponent(dbName)}`;
    await this.run(url.toString(), statements);
  }
}
