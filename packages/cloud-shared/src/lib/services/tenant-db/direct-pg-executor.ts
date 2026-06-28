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

  private async connect(connectionString: string): Promise<Client> {
    // The apps tenant Postgres is a self-managed node on the PRIVATE apps
    // network (10.30.x), provisioned with a self-signed cert. Current `pg`
    // parses `sslmode=require` in the DSN as `verify-full` and rejects the
    // self-signed chain ("self-signed certificate") — which would fail EVERY
    // tenant-DB provision in prod. Strip `sslmode` from the DSN textually (NOT
    // via `new URL().toString()`, which re-encodes the userinfo and can corrupt
    // the admin password) and set `ssl` explicitly: still TLS in-transit, but
    // skip CA-chain verification (safe — already private-network isolated). A
    // DSN-level `sslmode` would otherwise win over an explicit `ssl` object.
    // Verified live against the prod tenant DB (10.30.1.10) via the apps-control
    // node e2e (connection reaches auth; the self-signed reject is gone).
    // A local/CI throwaway Postgres has no TLS at all. When the DSN explicitly
    // opts out (`sslmode=disable`) or PGSSLMODE=disable is set, connect in
    // plaintext. Prod sets neither, so the TLS-with-skip-verify path is
    // preserved for the self-signed private-network tenant cluster.
    const noSsl =
      /[?&]sslmode=disable/i.test(connectionString) || process.env.PGSSLMODE === "disable";
    const cleaned = connectionString
      .replace(/[?&]sslmode=[^&]*/gi, (m) => (m[0] === "?" ? "?" : ""))
      .replace(/\?$/, "");
    const client = new Client({
      connectionString: cleaned,
      ...(noSsl ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    await client.connect();
    return client;
  }

  private async run(connectionString: string, statements: readonly string[]): Promise<void> {
    const client = await this.connect(connectionString);
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

  async databaseExists(dbName: string): Promise<boolean> {
    // `pg_database` is a shared catalog visible from the admin/maintenance
    // connection, so no per-tenant connection is needed.
    const client = await this.connect(this.adminDsn);
    try {
      const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      return (result.rowCount ?? 0) > 0;
    } finally {
      await client.end();
    }
  }
}
