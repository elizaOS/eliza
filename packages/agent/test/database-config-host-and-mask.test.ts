/**
 * PUT /api/database/config stores the host the user entered (not its resolved
 * IP) and never echoes the stored password. Boot re-validates that host and
 * pins the connection to the validated address while keeping the name for TLS.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  handleDatabaseRoute,
  maskConnectionString,
} from "../src/api/database.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import {
  applyDatabaseConfigToEnv,
  pinConfiguredPostgresUrl,
} from "../src/runtime/eliza.ts";

let dir: string;
let server: http.Server | null = null;
let baseUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "database-config-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  vi.stubEnv("POSTGRES_URL", undefined);
  vi.stubEnv("DATABASE_URL", undefined);
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function startServer(seed: ElizaConfig): Promise<void> {
  saveElizaConfig(seed);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleDatabaseRoute(req, res, null, url.pathname);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function send(method: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/api/database/config`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      config: { postgres?: Record<string, unknown> };
    },
  };
}

it("stores the entered hostname and masks the password in the PUT response", async () => {
  await startServer({});
  const saved = await send("PUT", {
    provider: "postgres",
    postgres: {
      host: "localhost",
      port: 5432,
      user: "agent",
      password: "hunter2",
      database: "agent",
      ssl: true,
    },
  });

  expect(saved.status).toBe(200);
  expect(loadElizaConfig().database?.postgres).toMatchObject({
    host: "localhost",
    password: "hunter2",
  });
  expect(saved.body.config.postgres?.host).toBe("localhost");
  expect(JSON.stringify(saved.body)).not.toContain("hunter2");
});

it("keeps a saved connection string as entered and masks it in both responses", async () => {
  await startServer({});
  const connectionString =
    "postgresql://agent:hunter2@localhost:5432/agent?sslmode=verify-full";
  const saved = await send("PUT", {
    provider: "postgres",
    postgres: { connectionString },
  });

  expect(saved.status).toBe(200);
  expect(loadElizaConfig().database?.postgres?.connectionString).toBe(
    connectionString,
  );
  expect(saved.body.config.postgres?.connectionString).toBe(
    "postgresql://agent:***@localhost:5432/agent?sslmode=verify-full",
  );

  const read = await send("GET");
  expect(read.body.config.postgres?.connectionString).toBe(
    "postgresql://agent:***@localhost:5432/agent?sslmode=verify-full",
  );
});

it("does not echo a password from disk on a provider-only PUT", async () => {
  await startServer({
    database: {
      provider: "postgres",
      postgres: { host: "localhost", password: "hunter2" },
    },
  });
  const saved = await send("PUT", { provider: "postgres" });

  expect(saved.status).toBe(200);
  expect(JSON.stringify(saved.body)).not.toContain("hunter2");
});

it("masks a password query parameter and an unparseable string whole", () => {
  expect(maskConnectionString("postgresql://u@h/db?password=secret")).toBe(
    "postgresql://u@h/db?password=***",
  );
  expect(maskConnectionString("host=h password=secret")).not.toContain(
    "secret",
  );
});

it("pins a configured URL at boot with hostaddr and keeps the hostname", async () => {
  const pinned = new URL(
    await pinConfiguredPostgresUrl(
      "postgresql://agent:pw@localhost:5432/agent?sslmode=verify-full",
    ),
  );

  expect(pinned.hostname).toBe("localhost");
  expect(pinned.searchParams.get("sslmode")).toBe("verify-full");
  expect(["127.0.0.1", "::1"]).toContain(pinned.searchParams.get("hostaddr"));
});

it("fails boot for a configured host in a blocked range", async () => {
  await expect(
    pinConfiguredPostgresUrl("postgresql://agent@169.254.169.254:5432/agent"),
  ).rejects.toThrow(/failed validation/);
});

it("leaves a Unix socket URL unpinned", async () => {
  const url = "postgresql://agent@/agent?host=/var/run/postgresql";
  await expect(pinConfiguredPostgresUrl(url)).resolves.toBe(url);
});

it("returns the URL to pin only when it came from config", () => {
  const fromConfig = applyDatabaseConfigToEnv({
    database: { provider: "postgres", postgres: { host: "db.example" } },
  } as ElizaConfig);
  expect(fromConfig).toBe("postgresql://postgres@db.example:5432/postgres");

  vi.stubEnv("POSTGRES_URL", "postgresql://ops@db.internal/agent");
  expect(
    applyDatabaseConfigToEnv({
      database: { provider: "postgres" },
    } as ElizaConfig),
  ).toBeNull();
});
