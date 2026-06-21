/**
 * Ephemeral throwaway Postgres for the tenant-DB isolation integration test (E6).
 *
 * The tenant-DB isolation assertions (race-safe slot claim, per-tenant DB created
 * atomically, cross-tenant CONNECT rejected by `REVOKE CONNECT ... FROM PUBLIC`)
 * can only be proven against a REAL superuser Postgres — they exercise `CREATE
 * ROLE` / `CREATE DATABASE` / `REVOKE CONNECT` DDL that no mock reproduces. To
 * keep the test runnable in CI/local WITHOUT pre-provisioned secrets, this module
 * spins a disposable Postgres container (docker) on a random host port, hands back
 * a superuser admin DSN, and tears the container down afterwards.
 *
 * Resolution order (first that applies wins):
 *   1. `APPS_TENANT_DB_TEST_DSN` already set  → use it as-is (external Postgres,
 *      e.g. a CI service container or `docker run` the operator already started).
 *      No container is created or destroyed here.
 *   2. docker present + opt-in (`TEST_LANE=post-merge` OR
 *      `APPS_TENANT_DB_EPHEMERAL=1`) → boot a throwaway `postgres:16-alpine`
 *      container, return its superuser DSN, register a teardown.
 *   3. otherwise → return `null`; the caller self-skips LOUDLY.
 *
 * The container is the SOLE backing store for the whole test: the same DSN must
 * also be `DATABASE_URL`, because `tenantDbClustersRepository` reads/writes the
 * `tenant_db_clusters` row through cloud-shared's `dbWrite` (which resolves
 * `DATABASE_URL`). The integration test sets both from `dsn`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

export interface EphemeralPostgres {
  /** Superuser admin DSN (sslmode=disable) reachable on the host. */
  dsn: string;
  /** `host:port` the DSN points at (what the provisioner embeds in tenant DSNs). */
  hostPort: string;
  /** Stop + remove the container. No-op for an externally supplied DSN. */
  stop: () => Promise<void>;
}

const POSTGRES_IMAGE = process.env.APPS_TENANT_DB_TEST_IMAGE ?? "postgres:16-alpine";
const SUPERUSER = "postgres";
const SUPERPASS = "ephemeral_admin_pw";
const READY_TIMEOUT_MS = 60_000;

function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 15_000,
    stdio: "ignore",
  });
  return probe.status === 0;
}

function optedIn(): boolean {
  return process.env.TEST_LANE === "post-merge" || process.env.APPS_TENANT_DB_EPHEMERAL === "1";
}

/** Pick a free host port by binding :0 through `node:net`. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not resolve a free port")));
      }
    });
  });
}

async function waitForReady(dsn: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: dsn });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `ephemeral Postgres never became ready within ${READY_TIMEOUT_MS}ms: ${String(lastErr)}`,
  );
}

/**
 * Resolve a superuser Postgres for the isolation test, booting a throwaway
 * container when needed. Returns `null` (with the caller responsible for a loud
 * skip) when no external DSN is set and docker/opt-in are unavailable.
 */
export async function acquireEphemeralPostgres(): Promise<EphemeralPostgres | null> {
  const external = process.env.APPS_TENANT_DB_TEST_DSN;
  if (external) {
    const u = new URL(external);
    return {
      dsn: external,
      hostPort: `${u.hostname}:${u.port || "5432"}`,
      stop: async () => {},
    };
  }

  if (!optedIn() || !dockerAvailable()) {
    return null;
  }

  // The production `DirectPgExecutor` forces `ssl: { rejectUnauthorized: false }`
  // (the tenant Postgres carries a self-signed cert on a private network). To
  // exercise that EXACT code path — not a weakened test fork — boot the throwaway
  // container with TLS on, fronted by a self-signed cert generated here. The DSN
  // we hand back is plain (no `sslmode`), but the provisioner connects through
  // DirectPgExecutor, which negotiates SSL against this cert.
  const certDir = mkdtempSync(join(tmpdir(), "tenant-db-e6-cert-"));
  const certPath = join(certDir, "server.crt");
  const keyPath = join(certDir, "server.key");
  const ssl = spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (ssl.status !== 0) {
    rmSync(certDir, { recursive: true, force: true });
    throw new Error(`failed to generate self-signed cert for ephemeral Postgres: ${ssl.stderr}`);
  }

  const port = await freePort();
  const name = `tenant-db-e6-${port}-${Date.now()}`;
  // Postgres refuses an SSL key owned/readable by anyone but the server user, and
  // a bind-mounted file keeps the HOST uid + perms — which the container's
  // `postgres` user can't read. So mount the cert dir read-only and, before
  // `postgres` starts, `install` (copy+chown+chmod) the key/cert into a
  // container-owned path with 0600/0644 via the entrypoint wrapper.
  const startCmd =
    "install -o postgres -g postgres -m 600 /pg-tls-src/server.key /tmp/server.key && " +
    "install -o postgres -g postgres -m 644 /pg-tls-src/server.crt /tmp/server.crt && " +
    "exec docker-entrypoint.sh postgres " +
    "-c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key";
  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      `POSTGRES_PASSWORD=${SUPERPASS}`,
      "-e",
      `POSTGRES_USER=${SUPERUSER}`,
      "-e",
      "POSTGRES_DB=postgres",
      "-v",
      `${certDir}:/pg-tls-src:ro`,
      "-p",
      `127.0.0.1:${port}:5432`,
      POSTGRES_IMAGE,
      "bash",
      "-c",
      startCmd,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (run.status !== 0) {
    rmSync(certDir, { recursive: true, force: true });
    throw new Error(
      `failed to start ephemeral Postgres container (${POSTGRES_IMAGE}): ${run.stderr || run.stdout}`,
    );
  }

  const hostPort = `127.0.0.1:${port}`;
  // Wait/ready probe connects WITHOUT ssl (plain TCP) just to confirm the server
  // is accepting; the provisioner's DirectPgExecutor uses SSL on top of it.
  const dsn = `postgresql://${SUPERUSER}:${SUPERPASS}@${hostPort}/postgres?sslmode=disable`;

  const stop = async () => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
    rmSync(certDir, { recursive: true, force: true });
  };

  try {
    await waitForReady(dsn);
  } catch (err) {
    await stop();
    throw err;
  }

  return { dsn, hostPort, stop };
}
