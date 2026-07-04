// Exercises tenant db provisioner behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  buildDeprovisionDdl,
  buildDsn,
  buildIdempotentAdminDdl,
  buildMaintenanceDbHardeningDdl,
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

describe("buildIdempotentAdminDdl — the hard cross-tenant boundary as a contract", () => {
  const ident = deriveTenantIdent(APP_ID);
  const ddl = buildIdempotentAdminDdl(ident, "s3cr3t", { databaseExists: false });

  test("creates the role BEFORE the database owns it (order is load-bearing)", () => {
    const roleIdx = ddl.findIndex((s) => s.includes("CREATE ROLE"));
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

  test("hardens shared maintenance databases before creating tenant credentials", () => {
    const hardening = buildMaintenanceDbHardeningDdl();
    expect(hardening).toEqual([
      `GRANT CONNECT ON DATABASE ${quoteIdent("postgres")} TO CURRENT_USER`,
      `GRANT CONNECT ON DATABASE ${quoteIdent("template1")} TO CURRENT_USER`,
      `REVOKE CONNECT ON DATABASE ${quoteIdent("postgres")} FROM PUBLIC`,
      `REVOKE CONNECT ON DATABASE ${quoteIdent("template1")} FROM PUBLIC`,
      "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    ]);
    expect(ddl.slice(0, hardening.length)).toEqual(hardening);
  });

  test("the role is least-privilege (no superuser/createdb/createrole)", () => {
    const createRole = ddl.find((s) => s.includes("CREATE ROLE"))!;
    expect(createRole).toContain("NOSUPERUSER");
    expect(createRole).toContain("NOCREATEDB");
    expect(createRole).toContain("NOCREATEROLE");
  });

  test("idempotent CREATE ROLE: DO block that swallows duplicate_object", () => {
    const createRole = ddl.find((s) => s.includes("CREATE ROLE"))!;
    expect(createRole).toContain("DO $$");
    expect(createRole).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    // The password literal must NOT sit inside the dollar-quoted DO block, where a
    // `$$` in the value could terminate it early — it is set by ALTER ROLE instead.
    expect(createRole).not.toContain("PASSWORD");
  });

  test("ALWAYS sets the role password (escaped) so a retry's DSN stays current", () => {
    const alter = ddl.find((s) => s.startsWith("ALTER ROLE"))!;
    expect(alter).toContain(`ALTER ROLE ${quoteIdent(ident.roleName)} WITH LOGIN PASSWORD`);
    expect(alter).toContain("'s3cr3t'");
  });

  test("escapes a password containing a single quote in the ALTER ROLE literal", () => {
    const evil = buildIdempotentAdminDdl(ident, "pw'; DROP DATABASE postgres;--", {
      databaseExists: false,
    });
    const alter = evil.find((s) => s.startsWith("ALTER ROLE"))!;
    expect(alter).toContain("''"); // escaped quote, not a break-out
  });

  test("emits CREATE DATABASE only when the database is absent", () => {
    const absent = buildIdempotentAdminDdl(ident, "s3cr3t", { databaseExists: false });
    const present = buildIdempotentAdminDdl(ident, "s3cr3t", { databaseExists: true });
    expect(absent.some((s) => s.startsWith("CREATE DATABASE"))).toBe(true);
    expect(present.some((s) => s.startsWith("CREATE DATABASE"))).toBe(false);
    // the role + connect lockdown are emitted in BOTH cases (always idempotent)
    expect(present.some((s) => s.includes("CREATE ROLE"))).toBe(true);
    expect(present.some((s) => s.startsWith("ALTER ROLE"))).toBe(true);
    expect(present.some((s) => s.startsWith("REVOKE CONNECT"))).toBe(true);
    expect(present.some((s) => s.startsWith("GRANT CONNECT"))).toBe(true);
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
  // The executor is the ONLY IO seam — we mock just that boundary. `exists` sets
  // a constant `databaseExists` result; `existsSeq` instead consumes one boolean
  // per call (to model a re-run where the DB is absent, then present).
  function recordingExecutor(opts: { exists?: boolean; existsSeq?: boolean[] } = {}) {
    const calls: Array<{ kind: "admin" | "db"; dbName?: string; statements: string[] }> = [];
    const seq = opts.existsSeq ? [...opts.existsSeq] : undefined;
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
        if (seq) {
          // Once drained, the DB stays in its last observed state.
          return seq.length > 1 ? (seq.shift() ?? false) : (seq[0] ?? false);
        }
        return opts.exists ?? false;
      },
    };
    return { calls, executor, existsCheckedFor: () => existsCheckedFor };
  }

  test("provisions: admin DDL first, then in-database DDL, returns the scoped DSN", async () => {
    const { calls, executor } = recordingExecutor({ exists: false });
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
    // a fresh provision (DB absent) DOES create the database
    expect(calls[0].statements.some((s) => s.startsWith("CREATE DATABASE"))).toBe(true);
  });

  test("provision() is DDL-idempotent: a retry (DB now present) succeeds, skips CREATE DATABASE, still rotates the password", async () => {
    const { calls, executor } = recordingExecutor({ existsSeq: [false, true] });
    let pw = 0;
    const provisioner = new SqlTenantDbProvisioner({
      cluster: { host: "apps-cluster-1" },
      executor,
      genPassword: () => `pw-${++pw}`,
    });

    // First provision: DB absent -> CREATE DATABASE emitted, DSN carries pw-1.
    const first = await provisioner.provision(APP_ID);
    expect(first.dsn).toContain(":pw-1@");
    const firstAdmin = calls.find((c) => c.kind === "admin")!;
    expect(firstAdmin.statements.some((s) => s.startsWith("CREATE DATABASE"))).toBe(true);

    // Second provision (the deploy RETRY): DB present now -> must NOT throw, must
    // NOT re-CREATE the database, must STILL set the (new) password on the role.
    const adminCallsBefore = calls.filter((c) => c.kind === "admin").length;
    const second = await provisioner.provision(APP_ID);
    const secondAdmin = calls.filter((c) => c.kind === "admin")[adminCallsBefore]!;

    expect(second.dsn).toContain(":pw-2@"); // rotated — caller gets a working credential
    expect(secondAdmin.statements.some((s) => s.startsWith("CREATE DATABASE"))).toBe(false);
    // role create (swallowed-dup DO block) + ALTER password still ran
    expect(secondAdmin.statements.some((s) => s.includes("CREATE ROLE"))).toBe(true);
    expect(
      secondAdmin.statements.some((s) => s.startsWith("ALTER ROLE") && s.includes("'pw-2'")),
    ).toBe(true);
  });

  test("provision() recovers a partial prior failure: role exists but database does not", async () => {
    // databaseExists=false (the DB never got created) while the role already
    // exists from the aborted attempt — the DO block swallows the duplicate role
    // and CREATE DATABASE runs to finish the job. No throw.
    const { calls, executor } = recordingExecutor({ exists: false });
    const provisioner = new SqlTenantDbProvisioner({
      cluster: { host: "apps-cluster-1" },
      executor,
      genPassword: () => "recover-pw",
    });
    const ident = deriveTenantIdent(APP_ID);

    const result = await provisioner.provision(APP_ID);
    expect(result.dsn).toContain(":recover-pw@");

    const admin = calls.find((c) => c.kind === "admin")!;
    const createRole = admin.statements.find((s) => s.includes("CREATE ROLE"))!;
    expect(createRole).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    expect(admin.statements.some((s) => s.startsWith("CREATE DATABASE"))).toBe(true);
    // existence was probed against the right DB
    expect(admin.statements.some((s) => s.includes(quoteIdent(ident.dbName)))).toBe(true);
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
