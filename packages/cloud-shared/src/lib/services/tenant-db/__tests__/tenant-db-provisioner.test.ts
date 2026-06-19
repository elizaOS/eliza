import { describe, expect, test } from "bun:test";
import {
  buildAdminDdl,
  buildDeprovisionDdl,
  buildDsn,
  buildTenantDdl,
  deriveTenantIdent,
  quoteIdent,
  SqlTenantDbProvisioner,
  type TenantDbSqlExecutor,
} from "../tenant-db-provisioner";

const APP_ID = "11111111-2222-3333-4444-555555555555";

describe("deriveTenantIdent", () => {
  test("derives valid, stable db + role identifiers from an app id", () => {
    const a = deriveTenantIdent(APP_ID);
    expect(a).toEqual(deriveTenantIdent(APP_ID)); // stable
    expect(a.dbName).toMatch(/^db_app_[a-z0-9]+$/);
    expect(a.roleName).toMatch(/^app_[a-z0-9]+$/);
    expect(a.dbName.length).toBeLessThanOrEqual(63);
    expect(a.roleName.length).toBeLessThanOrEqual(63);
  });

  test("rejects an app id with too little entropy", () => {
    expect(() => deriveTenantIdent("a-b-c")).toThrow();
  });
});

describe("quoteIdent", () => {
  test("double-quotes and escapes embedded quotes", () => {
    expect(quoteIdent("db_app_x")).toBe('"db_app_x"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe("buildAdminDdl — the hard cross-tenant boundary as a contract", () => {
  const ident = deriveTenantIdent(APP_ID);
  const ddl = buildAdminDdl(ident, "s3cr3t");

  test("creates the role BEFORE the database owns it (order is load-bearing)", () => {
    const roleIdx = ddl.findIndex((s) => s.startsWith("CREATE ROLE"));
    const dbIdx = ddl.findIndex((s) => s.startsWith("CREATE DATABASE"));
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(dbIdx).toBeGreaterThan(roleIdx);
  });

  test("REVOKEs CONNECT from PUBLIC and GRANTs it only to the tenant role", () => {
    const joined = ddl.join("\n");
    expect(joined).toContain(`REVOKE CONNECT ON DATABASE ${quoteIdent(ident.dbName)} FROM PUBLIC`);
    expect(joined).toContain(
      `GRANT CONNECT ON DATABASE ${quoteIdent(ident.dbName)} TO ${quoteIdent(ident.roleName)}`,
    );
  });

  test("the role is least-privilege (no superuser/createdb/createrole)", () => {
    const createRole = ddl.find((s) => s.startsWith("CREATE ROLE"))!;
    expect(createRole).toContain("NOSUPERUSER");
    expect(createRole).toContain("NOCREATEDB");
    expect(createRole).toContain("NOCREATEROLE");
  });

  test("escapes a password containing a single quote", () => {
    const evil = buildAdminDdl(ident, "pw'; DROP DATABASE postgres;--");
    const createRole = evil.find((s) => s.startsWith("CREATE ROLE"))!;
    expect(createRole).toContain("''"); // escaped quote, not a break-out
  });
});

describe("buildTenantDdl", () => {
  test("locks the public schema to the tenant role only", () => {
    const ident = deriveTenantIdent(APP_ID);
    const ddl = buildTenantDdl(ident);
    expect(ddl).toContain("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    expect(ddl).toContain(`GRANT ALL ON SCHEMA public TO ${quoteIdent(ident.roleName)}`);
  });
});

describe("buildDeprovisionDdl", () => {
  test("drops the database WITH FORCE, then the role", () => {
    const ident = deriveTenantIdent(APP_ID);
    const ddl = buildDeprovisionDdl(ident);
    expect(ddl[0]).toContain("DROP DATABASE IF EXISTS");
    expect(ddl[0]).toContain("WITH (FORCE)");
    expect(ddl[1]).toContain("DROP ROLE IF EXISTS");
  });
});

describe("buildDsn", () => {
  test("builds an sslmode=require DSN with URL-encoded credentials", () => {
    const dsn = buildDsn({
      host: "apps-cluster-1:5432",
      roleName: "app_x",
      password: "p@ss/w:rd",
      dbName: "db_app_x",
    });
    expect(dsn).toBe(
      "postgresql://app_x:p%40ss%2Fw%3Ard@apps-cluster-1:5432/db_app_x?sslmode=require",
    );
  });
});

describe("SqlTenantDbProvisioner", () => {
  function recordingExecutor(opts: { exists?: boolean } = {}) {
    const calls: Array<{ kind: "admin" | "db"; dbName?: string; statements: string[] }> = [];
    let existsCheckedFor: string | undefined;
    const executor: TenantDbSqlExecutor = {
      async execAdmin(statements) {
        calls.push({ kind: "admin", statements: [...statements] });
      },
      async execInDatabase(dbName, statements) {
        calls.push({ kind: "db", dbName, statements: [...statements] });
      },
      async databaseExists(dbName) {
        existsCheckedFor = dbName;
        return opts.exists ?? true;
      },
    };
    return { calls, executor, existsCheckedFor: () => existsCheckedFor };
  }

  test("provisions: admin DDL first, then in-database DDL, returns the scoped DSN", async () => {
    const { calls, executor } = recordingExecutor();
    const provisioner = new SqlTenantDbProvisioner({
      cluster: { host: "apps-cluster-1" },
      executor,
      genPassword: () => "fixed-password",
    });

    const result = await provisioner.provision(APP_ID);
    const ident = deriveTenantIdent(APP_ID);

    expect(result.dbName).toBe(ident.dbName);
    expect(result.roleName).toBe(ident.roleName);
    expect(result.dsn).toBe(
      `postgresql://${ident.roleName}:fixed-password@apps-cluster-1/${ident.dbName}?sslmode=require`,
    );

    // ordering: admin (role+db+connect) before in-database (schema) lockdown
    expect(calls[0].kind).toBe("admin");
    expect(calls[1].kind).toBe("db");
    expect(calls[1].dbName).toBe(ident.dbName);
    // the boundary statement actually got issued
    expect(calls[0].statements.join("\n")).toContain("REVOKE CONNECT ON DATABASE");
  });

  test("deprovisions via admin DROP DATABASE/ROLE and reports the DB existed", async () => {
    const { calls, executor, existsCheckedFor } = recordingExecutor({ exists: true });
    const provisioner = new SqlTenantDbProvisioner({
      cluster: { host: "h" },
      executor,
      genPassword: () => "x",
    });
    const ident = deriveTenantIdent(APP_ID);
    const result = await provisioner.deprovision(APP_ID);
    expect(result).toEqual({ existed: true });
    // existence was checked against the right DB BEFORE the DROP
    expect(existsCheckedFor()).toBe(ident.dbName);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("admin");
    expect(calls[0].statements[0]).toContain("DROP DATABASE IF EXISTS");
  });

  test("deprovision reports existed:false when the DB is already gone (gates the slot release)", async () => {
    const { executor } = recordingExecutor({ exists: false });
    const provisioner = new SqlTenantDbProvisioner({
      cluster: { host: "h" },
      executor,
      genPassword: () => "x",
    });
    const result = await provisioner.deprovision(APP_ID);
    expect(result).toEqual({ existed: false });
  });
});
