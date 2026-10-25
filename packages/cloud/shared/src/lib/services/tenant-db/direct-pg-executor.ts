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

import { readFileSync } from "node:fs";
import { Client, type ClientConfig } from "pg";
import { logger } from "../../utils/logger";
import type { TenantDbSqlExecutor } from "./tenant-db-provisioner";

let warnedUnverifiedTls = false;

/**
 * Read the operator-pinned CA anchor for the tenant cluster: `TENANT_DB_TLS_CA`
 * (inline PEM) or `PGSSLROOTCERT` (path to the PEM, the standard libpq name).
 * An unreadable configured file throws — provisioning must fail fast rather
 * than silently fall back to an unverified connection.
 */
function readPinnedClusterCa(): string | null {
  const inline = process.env.TENANT_DB_TLS_CA;
  if (inline && inline.trim().length > 0) return inline;
  const caPath = process.env.PGSSLROOTCERT?.trim();
  if (!caPath) return null;
  return readFileSync(caPath, "utf8");
}

/**
 * TLS config for the tenant-cluster connection.
 *
 * The cluster is a self-managed node on the PRIVATE apps network (10.30.x)
 * serving a self-signed cert, so a public-CA chain check can never pass.
 * Verification is therefore PINNED: when the operator configures the cluster
 * cert or internal CA, the server certificate is verified against exactly that
 * anchor (`rejectUnauthorized: true`), so an interposer on the private segment
 * presenting its own cert is detected instead of silently trusted. Hostname
 * checking is relaxed (libpq `verify-ca` semantics): the pinned anchor IS the
 * identity, and the self-signed cert carries no SAN for the private IP.
 *
 * Without a pinned CA there is nothing to verify against: the connection stays
 * encrypted but unverified, and a one-time warning keeps that residual visible
 * to operators instead of silent.
 */
function tenantClusterSsl(): ClientConfig["ssl"] {
  const ca = readPinnedClusterCa();
  if (ca) {
    return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  }
  if (!warnedUnverifiedTls) {
    warnedUnverifiedTls = true;
    logger.warn(
      "[DirectPgExecutor] No pinned tenant-cluster CA (TENANT_DB_TLS_CA / PGSSLROOTCERT): " +
        "provisioning connections are TLS-encrypted but NOT certificate-verified. " +
        "Pin the cluster CA to make interposition on the private network detectable.",
    );
  }
  return { rejectUnauthorized: false };
}

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
    // the admin password) and set `ssl` explicitly. A DSN-level `sslmode` would
    // otherwise win over an explicit `ssl` object. See tenantClusterSsl() for
    // the pinned-CA verification policy.
    // A local/CI throwaway Postgres has no TLS at all. When the DSN explicitly
    // opts out (`sslmode=disable`) or PGSSLMODE=disable is set, connect in
    // plaintext. Prod sets neither, so the TLS path is preserved for the
    // self-signed private-network tenant cluster.
    const noSsl =
      /[?&]sslmode=disable/i.test(connectionString) || process.env.PGSSLMODE === "disable";
    const cleaned = connectionString
      .replace(/[?&]sslmode=[^&]*/gi, (m) => (m[0] === "?" ? "?" : ""))
      .replace(/\?$/, "");
    const client = new Client({
      connectionString: cleaned,
      ...(noSsl ? {} : { ssl: tenantClusterSsl() }),
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
