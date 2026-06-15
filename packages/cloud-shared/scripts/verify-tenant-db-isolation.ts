import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { DirectPgExecutor } from "../src/lib/services/tenant-db/direct-pg-executor";
import {
  deriveTenantIdent,
  SqlTenantDbProvisioner,
} from "../src/lib/services/tenant-db/tenant-db-provisioner";

const ADMIN = "postgresql://postgres:adminpw@localhost:55432/postgres";
const APP_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

// The throwaway local Postgres has no TLS; the real cluster does. Strip the
// (correct-for-prod) sslmode=require for these local connection checks so a
// rejection is genuinely REVOKE CONNECT, not a TLS handshake failure.
const local = (dsn: string) => dsn.replace("sslmode=require", "sslmode=disable");

async function canConnect(dsn: string): Promise<{ ok: boolean; err?: string }> {
  const c = new Client({ connectionString: local(dsn) });
  try {
    await c.connect();
    await c.query("select 1");
    await c.end();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

const provisioner = new SqlTenantDbProvisioner({
  cluster: { host: "localhost:55432" },
  executor: new DirectPgExecutor(ADMIN),
  genPassword: () => randomBytes(16).toString("hex"),
});

const a = await provisioner.provision(APP_A);
const b = await provisioner.provision(APP_B);
const identA = deriveTenantIdent(APP_A);
const identB = deriveTenantIdent(APP_B);
console.log(`provisioned A=${identA.dbName} (role ${identA.roleName}), B=${identB.dbName}`);

// 1. Each tenant can reach its OWN database.
check("tenant A connects to its own DB", (await canConnect(a.dsn)).ok);
check("tenant B connects to its own DB", (await canConnect(b.dsn)).ok);

// 2. THE BOUNDARY: tenant A's credentials must NOT connect to tenant B's DB.
const aCredsToBDb = a.dsn.replace(`/${identA.dbName}?`, `/${identB.dbName}?`);
const cross = await canConnect(aCredsToBDb);
check(
  "tenant A is REJECTED from tenant B's DB (REVOKE CONNECT)",
  !cross.ok,
  cross.ok ? "BREACH: connected!" : `rejected: ${(cross.err ?? "").slice(0, 70)}`,
);

// 3. Tenant A can actually use its own DB (schema privileges granted).
const ca = new Client({ connectionString: local(a.dsn) });
await ca.connect();
try {
  await ca.query("create table t_demo (id int)");
  await ca.query("insert into t_demo values (1)");
  const r = await ca.query("select count(*)::int as n from t_demo");
  check("tenant A can create + write tables in its own DB", r.rows[0].n === 1);
} catch (e) {
  check("tenant A can create + write tables in its own DB", false, String(e).slice(0, 70));
} finally {
  await ca.end();
}

// 4. The tenant role is least-privilege (cannot create databases).
const ca2 = new Client({ connectionString: local(a.dsn) });
await ca2.connect();
try {
  await ca2.query('create database "sneaky_db"');
  check("tenant A CANNOT create databases (least-privilege)", false, "BREACH: created a DB!");
} catch {
  check("tenant A CANNOT create databases (least-privilege)", true);
} finally {
  await ca2.end();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
