/**
 * TLS pinning contract for DirectPgExecutor: the tenant cluster serves a
 * self-signed cert on the private apps network, so provisioning connections
 * must verify the server against a PINNED cluster CA (TENANT_DB_TLS_CA inline
 * PEM / PGSSLROOTCERT file) with rejectUnauthorized:true — never the default
 * public-CA chain (which self-signed fails) and, once pinned, never
 * skip-verify. Without a pin the historical encrypted-but-unverified path is
 * kept, and an unreadable pin file must fail fast. `pg` is faked (Client) so
 * the real executor ssl-config logic runs.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CapturedConfig {
  connectionString?: string;
  ssl?: unknown;
}

const clientConfigs: CapturedConfig[] = [];

class FakeClient {
  constructor(public readonly config: CapturedConfig) {
    clientConfigs.push(config);
  }
  async connect(): Promise<void> {}
  async query() {
    return { rowCount: 0, rows: [] };
  }
  async end(): Promise<void> {}
}

mock.module("pg", () => ({ Client: FakeClient }));

const ADMIN_DSN = "postgres://admin:pw@10.30.1.10:5432/postgres";
const PINNED_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBfakepinnedclusterCA\n-----END CERTIFICATE-----\n";

const TLS_ENV_KEYS = ["TENANT_DB_TLS_CA", "PGSSLROOTCERT", "PGSSLMODE"] as const;

describe("DirectPgExecutor — tenant-cluster TLS pinning", () => {
  const savedEnv = new Map<string, string | undefined>();
  let certDir: string | null = null;

  beforeEach(() => {
    clientConfigs.length = 0;
    for (const key of TLS_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TLS_ENV_KEYS) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    savedEnv.clear();
    if (certDir) {
      rmSync(certDir, { recursive: true, force: true });
      certDir = null;
    }
  });

  async function connectOnce(dsn: string = ADMIN_DSN): Promise<CapturedConfig> {
    const { DirectPgExecutor } = await import("./direct-pg-executor");
    const exec = new DirectPgExecutor(dsn);
    await exec.databaseExists("tenant_db");
    expect(clientConfigs).toHaveLength(1);
    return clientConfigs[0];
  }

  it("verifies against the pinned inline CA (TENANT_DB_TLS_CA) with rejectUnauthorized:true", async () => {
    process.env.TENANT_DB_TLS_CA = PINNED_CA;

    const config = await connectOnce();
    const ssl = config.ssl as {
      ca: string;
      rejectUnauthorized: boolean;
      checkServerIdentity: unknown;
    };
    expect(ssl.ca).toBe(PINNED_CA);
    expect(ssl.rejectUnauthorized).toBe(true);
    // verify-ca semantics: the pinned anchor is the identity, so the
    // self-signed cert's missing IP SAN does not fail the handshake.
    expect(typeof ssl.checkServerIdentity).toBe("function");
  });

  it("reads the pinned CA from the PGSSLROOTCERT file", async () => {
    certDir = mkdtempSync(join(tmpdir(), "direct-pg-executor-tls-"));
    writeFileSync(join(certDir, "cluster-ca.pem"), PINNED_CA);
    process.env.PGSSLROOTCERT = join(certDir, "cluster-ca.pem");

    const config = await connectOnce();
    const ssl = config.ssl as { ca: string; rejectUnauthorized: boolean };
    expect(ssl.ca).toBe(PINNED_CA);
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it("fails fast when the configured PGSSLROOTCERT file is unreadable", async () => {
    process.env.PGSSLROOTCERT = "/nonexistent/tenant-cluster-ca.pem";

    const { DirectPgExecutor } = await import("./direct-pg-executor");
    const exec = new DirectPgExecutor(ADMIN_DSN);
    await expect(exec.databaseExists("tenant_db")).rejects.toThrow();
    expect(clientConfigs).toHaveLength(0);
  });

  it("keeps the encrypted-but-unverified path when no CA is pinned", async () => {
    const config = await connectOnce();
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("sslmode=disable connects in plaintext even with a pinned CA configured", async () => {
    process.env.TENANT_DB_TLS_CA = PINNED_CA;

    const config = await connectOnce(`${ADMIN_DSN}?sslmode=disable`);
    expect(config.ssl).toBeUndefined();
    expect(config.connectionString).not.toContain("sslmode");
  });
});
