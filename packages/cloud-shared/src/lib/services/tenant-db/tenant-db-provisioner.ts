/**
 * Per-tenant database isolation (Apps / Product 2) — the pure provisioning core.
 *
 * Strategy: DATABASE-per-tenant + ROLE-per-tenant on a shared, app-owned
 * Postgres cluster. Each app gets its own database owned by its own login role,
 * and `REVOKE CONNECT ON DATABASE ... FROM PUBLIC` + `GRANT CONNECT ... TO
 * <role>` means a tenant credential is rejected at the connection/auth layer
 * before any query runs — a HARD cross-tenant boundary, not encryption-at-rest.
 * CREATE DATABASE / CREATE ROLE is O(1) cheap DDL with effectively unbounded
 * count per cluster, sharded across N clusters by the pool (a later unit), so
 * it structurally defeats any single-provider project/branch cap.
 *
 * This module is the PURE core: identifier derivation, the DDL/DSN string
 * builders (the boundary expressed as a contract), and an orchestrator driven
 * by injected executors — zero `pg`/Neon/network imports, so the entire
 * behaviour (including the REVOKE-CONNECT boundary) is unit-testable with mocks.
 * The concrete backend (self-managed Postgres now; Neon-as-cluster later) plugs
 * in behind {@link TenantDbSqlExecutor} with no change here.
 *
 * NOTE: never touches the agent path — agents keep `process.env.DATABASE_URL`.
 */

/** Postgres identifiers (database + login role) for one tenant app. */
export interface TenantDbIdent {
  dbName: string;
  roleName: string;
}

/** A provisioned tenant DB: the identifiers + the role's scoped DSN. */
export interface ProvisionedTenantDb extends TenantDbIdent {
  /** `postgresql://<role>:<pw>@<host>/<db>?sslmode=require` — the ONLY creds the app gets. */
  dsn: string;
}

/** Where a tenant DB is created (one shard of the apps cluster pool). */
export interface TenantDbCluster {
  /** Host[:port] of the cluster, used to build the tenant DSN. */
  host: string;
}

/**
 * Executes DDL against the cluster. Two surfaces because tenant schema grants
 * must run INSIDE the freshly-created database, on a separate connection from
 * the admin connection that created it. Statements run one-at-a-time and
 * OUTSIDE a transaction — `CREATE DATABASE` cannot run in a transaction block.
 */
export interface TenantDbSqlExecutor {
  /** Run admin DDL on the cluster's maintenance database (e.g. `postgres`). */
  execAdmin(statements: readonly string[]): Promise<void>;
  /** Run DDL connected to a specific tenant database. */
  execInDatabase(dbName: string, statements: readonly string[]): Promise<void>;
  /**
   * Whether a database currently exists on the cluster (queried via the admin
   * connection against `pg_database`). The deprovision path checks this BEFORE
   * the `DROP DATABASE IF EXISTS` so the caller can release the cluster slot
   * exactly once — a re-run finds the DB already gone and must not double-free.
   */
  databaseExists(dbName: string): Promise<boolean>;
}

export interface SqlTenantDbProvisionerDeps {
  cluster: TenantDbCluster;
  executor: TenantDbSqlExecutor;
  /** Generates a strong random role password. Injected for deterministic tests. */
  genPassword: () => string;
}

/** Double-quote a Postgres identifier, escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quote a Postgres string literal, escaping embedded quotes. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Derive stable, collision-free Postgres identifiers from an app id. The id is
 * lowercased and stripped to `[a-z0-9]`, so identifiers are always valid and
 * never need quoting for correctness (we still quote in DDL defensively).
 */
export function deriveTenantIdent(appId: string): TenantDbIdent {
  const slug = appId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (slug.length < 8) {
    throw new Error(`deriveTenantIdent: appId ${appId} yields too short a slug (${slug.length})`);
  }
  const short = slug.slice(0, 24);
  return { dbName: `db_app_${short}`, roleName: `app_${short}` };
}

/**
 * Admin-connection DDL: create the role, create its database, and lock down
 * connect privileges so ONLY this role can open the database. Statement order
 * is load-bearing — the role must exist before the database can be owned by it.
 */
export function buildAdminDdl(ident: TenantDbIdent, password: string): string[] {
  const role = quoteIdent(ident.roleName);
  const db = quoteIdent(ident.dbName);
  return [
    `CREATE ROLE ${role} LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    `CREATE DATABASE ${db} OWNER ${role}`,
    `REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${db} TO ${role}`,
  ];
}

/**
 * In-database DDL (run connected to the new database): take the public schema
 * away from PUBLIC and grant it to the tenant role only. Closes the
 * "PUBLIC can create in public schema" default so a tenant role is the sole
 * principal inside its own database.
 */
export function buildTenantDdl(ident: TenantDbIdent): string[] {
  const role = quoteIdent(ident.roleName);
  return ["REVOKE ALL ON SCHEMA public FROM PUBLIC", `GRANT ALL ON SCHEMA public TO ${role}`];
}

/** Teardown DDL: drop the database (forcing connections closed) then the role. */
export function buildDeprovisionDdl(ident: TenantDbIdent): string[] {
  return [
    `DROP DATABASE IF EXISTS ${quoteIdent(ident.dbName)} WITH (FORCE)`,
    `DROP ROLE IF EXISTS ${quoteIdent(ident.roleName)}`,
  ];
}

/** Build the role-scoped connection string. Credentials are URL-encoded. */
export function buildDsn(params: {
  host: string;
  roleName: string;
  password: string;
  dbName: string;
}): string {
  const user = encodeURIComponent(params.roleName);
  const pw = encodeURIComponent(params.password);
  const db = encodeURIComponent(params.dbName);
  return `postgresql://${user}:${pw}@${params.host}/${db}?sslmode=require`;
}

/**
 * Orchestrates provisioning over an injected executor: derive identifiers,
 * mint a password, run admin DDL (role+db+connect lockdown), then in-database
 * DDL (schema lockdown), and return the role-scoped DSN. Pure of any real DB
 * driver — the executor is the only IO seam.
 */
export class SqlTenantDbProvisioner {
  private readonly cluster: TenantDbCluster;
  private readonly executor: TenantDbSqlExecutor;
  private readonly genPassword: () => string;

  constructor(deps: SqlTenantDbProvisionerDeps) {
    this.cluster = deps.cluster;
    this.executor = deps.executor;
    this.genPassword = deps.genPassword;
  }

  async provision(appId: string): Promise<ProvisionedTenantDb> {
    const ident = deriveTenantIdent(appId);
    const password = this.genPassword();
    await this.executor.execAdmin(buildAdminDdl(ident, password));
    await this.executor.execInDatabase(ident.dbName, buildTenantDdl(ident));
    return {
      ...ident,
      dsn: buildDsn({
        host: this.cluster.host,
        roleName: ident.roleName,
        password,
        dbName: ident.dbName,
      }),
    };
  }

  async deprovision(appId: string): Promise<{ existed: boolean }> {
    const ident = deriveTenantIdent(appId);
    // Snapshot existence BEFORE the DROP so the caller releases the cluster slot
    // exactly once. `DROP DATABASE IF EXISTS` succeeds whether or not the DB was
    // there, giving no signal of its own — so a re-run would otherwise decrement
    // the slot a second time and free phantom capacity. (#8342)
    const existed = await this.executor.databaseExists(ident.dbName);
    await this.executor.execAdmin(buildDeprovisionDdl(ident));
    return { existed };
  }
}
