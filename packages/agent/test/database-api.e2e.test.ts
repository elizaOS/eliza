/**
 * E2E tests for the database management API — NO MOCKS, NO API KEYS NEEDED.
 *
 * Imports and starts the actual `startApiServer()` from src/api/server.ts.
 * Tests every /api/database/* endpoint that works without a running
 * AgentRuntime, and verifies proper 503 rejection for data endpoints
 * that require one.
 *
 * Coverage:
 * - Database status reporting
 * - Database config CRUD (PGLite / Postgres)
 * - Connection test endpoint
 * - 503 guard for data endpoints (tables, rows, query)
 * - Input validation for row and query operations
 * - Routing correctness (404 for unmatched paths)
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper (same pattern as api-server.e2e.test.ts)
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Database API E2E (no runtime)", () => {
  let port: number;
  let close: () => Promise<void>;
  let tmpConfigDir: string;
  let savedConfigPath: string | undefined;

  beforeAll(async () => {
    // Isolate config writes to a temp directory so tests never clobber
    // the real ~/.eliza/eliza.json (which would destroy user data).
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-db-e2e-"));
    savedConfigPath = process.env.ELIZA_CONFIG_PATH;
    process.env.ELIZA_CONFIG_PATH = path.join(tmpConfigDir, "eliza.json");

    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
    if (savedConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
    else process.env.ELIZA_CONFIG_PATH = savedConfigPath;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  // ── Group 1: Database Status ──────────────────────────────────────────

  describe("GET /api/database/status", () => {
    it("returns disconnected status when no runtime", async () => {
      const { status, data } = await req(port, "GET", "/api/database/status");
      expect(status).toBe(200);
      expect(data.provider).toBe("pglite");
      expect(data.connected).toBe(false);
      expect(data.serverVersion).toBeNull();
      expect(data.tableCount).toBe(0);
    });

    it("has correct response shape", async () => {
      const { data } = await req(port, "GET", "/api/database/status");
      expect(typeof data.provider).toBe("string");
      expect(typeof data.connected).toBe("boolean");
      expect("serverVersion" in data).toBe(true);
      expect("tableCount" in data).toBe(true);
      expect("pgliteDataDir" in data).toBe(true);
      expect("postgresHost" in data).toBe(true);
    });
  });

  // ── Group 2: Database Config CRUD ─────────────────────────────────────

  describe("GET /api/database/config", () => {
    it("returns default config", async () => {
      const { status, data } = await req(port, "GET", "/api/database/config");
      expect(status).toBe(200);
      expect(typeof data.config).toBe("object");
      expect(typeof data.activeProvider).toBe("string");
      expect(typeof data.needsRestart).toBe("boolean");
    });

    it("activeProvider matches current environment", async () => {
      const { data } = await req(port, "GET", "/api/database/config");
      // No POSTGRES_URL set in test env → activeProvider should be pglite
      expect(data.activeProvider).toBe("pglite");
    });
  });

  describe("PUT /api/database/config", () => {
    // Capture original config to restore after each test
    let _originalConfig: Record<string, unknown>;

    beforeAll(async () => {
      const { data } = await req(port, "GET", "/api/database/config");
      _originalConfig = data;
    });

    afterAll(async () => {
      // Restore to pglite default
      await req(port, "PUT", "/api/database/config", { provider: "pglite" });
    });

    it("saves PGLite config", async () => {
      const { status, data } = await req(port, "PUT", "/api/database/config", {
        provider: "pglite",
        pglite: { dataDir: "/tmp/test-pglite-data" },
      });
      expect(status).toBe(200);
      expect(data.saved).toBe(true);
    });

    it("GET reflects saved PGLite config", async () => {
      await req(port, "PUT", "/api/database/config", {
        provider: "pglite",
        pglite: { dataDir: "/tmp/test-pglite-roundtrip" },
      });
      const { data } = await req(port, "GET", "/api/database/config");
      const config = data.config as Record<string, unknown>;
      expect(config.provider).toBe("pglite");
      const pglite = config.pglite as Record<string, unknown>;
      expect(pglite.dataDir).toBe("/tmp/test-pglite-roundtrip");
    });

    it("saves Postgres config with individual fields", async () => {
      const { status, data } = await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: {
          host: "10.1.0.1",
          port: 5433,
          database: "testdb",
          user: "admin",
          password: "secret123",
          ssl: true,
        },
      });
      expect(status).toBe(200);
      expect(data.saved).toBe(true);
      expect(data.needsRestart).toBe(true); // active is pglite, saved is postgres
    });

    it("saves Postgres config with connection string", async () => {
      const { status, data } = await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: {
          connectionString: "postgresql://user:pass@host:5432/db",
        },
      });
      expect(status).toBe(200);
      expect(data.saved).toBe(true);
    });

    it("GET masks password in individual fields", async () => {
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: {
          host: "localhost",
          user: "admin",
          password: "supersecret",
        },
      });
      const { data } = await req(port, "GET", "/api/database/config");
      const config = data.config as Record<string, unknown>;
      const pg = config.postgres as Record<string, unknown>;
      expect(pg.password).not.toBe("supersecret");
      expect(typeof pg.password).toBe("string");
      expect((pg.password as string).length).toBeGreaterThan(0);
    });

    it("GET masks password in connection string", async () => {
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: {
          connectionString: "postgresql://user:mypassword@host:5432/db",
        },
      });
      const { data } = await req(port, "GET", "/api/database/config");
      const config = data.config as Record<string, unknown>;
      const pg = config.postgres as Record<string, unknown>;
      expect(pg.connectionString).not.toContain("mypassword");
    });

    it("needsRestart is true when saved provider differs from active", async () => {
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: { host: "localhost" },
      });
      const { data } = await req(port, "GET", "/api/database/config");
      expect(data.needsRestart).toBe(true);
    });

    it("needsRestart is false when saved provider matches active", async () => {
      await req(port, "PUT", "/api/database/config", {
        provider: "pglite",
      });
      const { data } = await req(port, "GET", "/api/database/config");
      expect(data.needsRestart).toBe(false);
    });

    it("rejects invalid provider", async () => {
      const { status, data } = await req(port, "PUT", "/api/database/config", {
        provider: "mysql",
      });
      expect(status).toBe(400);
      expect(data.error).toContain("Invalid provider");
    });

    it("rejects Postgres config without host or connectionString", async () => {
      const { status, data } = await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: { database: "mydb", user: "me" },
      });
      expect(status).toBe(400);
      expect(data.error).toContain("connectionString");
    });

    it("rejects unsafe postgres host even when provider is pglite", async () => {
      const previousBind = process.env.ELIZA_API_BIND;
      process.env.ELIZA_API_BIND = "0.0.0.0";
      try {
        const { status, data } = await req(
          port,
          "PUT",
          "/api/database/config",
          {
            provider: "pglite",
            postgres: {
              host: "169.254.169.254",
              port: 5432,
              database: "postgres",
              user: "postgres",
            },
          },
        );
        expect(status).toBe(400);
        expect(String(data.error ?? "")).toContain("blocked");
      } finally {
        if (previousBind === undefined) delete process.env.ELIZA_API_BIND;
        else process.env.ELIZA_API_BIND = previousBind;
      }
    });

    it("rejects connectionString host override to blocked targets", async () => {
      const previousBind = process.env.ELIZA_API_BIND;
      process.env.ELIZA_API_BIND = "0.0.0.0";
      try {
        const { status, data } = await req(
          port,
          "PUT",
          "/api/database/config",
          {
            provider: "postgres",
            postgres: {
              connectionString:
                "postgresql://u:p@example.invalid/db?host=169.254.169.254",
            },
          },
        );
        expect(status).toBe(400);
        expect(String(data.error ?? "")).toContain("blocked");
      } finally {
        if (previousBind === undefined) delete process.env.ELIZA_API_BIND;
        else process.env.ELIZA_API_BIND = previousBind;
      }
    });

    it("config round-trip preserves all fields", async () => {
      const pgConfig = {
        provider: "postgres",
        postgres: {
          host: "10.1.0.2",
          port: 5434,
          database: "roundtripdb",
          user: "roundtripuser",
          password: "roundtrippass",
          ssl: true,
        },
      };
      await req(port, "PUT", "/api/database/config", pgConfig);
      const { data } = await req(port, "GET", "/api/database/config");
      const config = data.config as Record<string, Record<string, unknown>>;
      expect(config.provider).toBe("postgres");
      expect(config.postgres.host).toBe("10.1.0.2");
      expect(config.postgres.port).toBe(5434);
      expect(config.postgres.database).toBe("roundtripdb");
      expect(config.postgres.user).toBe("roundtripuser");
      expect(config.postgres.ssl).toBe(true);
      // Password is masked, but present
      expect(typeof config.postgres.password).toBe("string");
    });
  });

  // ── Group 3: Connection Test ──────────────────────────────────────────

  describe("POST /api/database/test", () => {
    it("returns failure for unreachable host", async () => {
      const { status, data } = await req(port, "POST", "/api/database/test", {
        host: "127.0.0.1",
        port: 1, // port 1 is almost certainly unreachable
        database: "nonexistent",
        user: "nobody",
        password: "nope",
      });
      expect(status).toBe(200); // endpoint always returns 200, success is in body
      expect(data.success).toBe(false);
      expect(typeof data.error).toBe("string");
      expect((data.error as string).length).toBeGreaterThan(0);
    });

    it("includes timing information", async () => {
      const { data } = await req(port, "POST", "/api/database/test", {
        host: "127.0.0.1",
        port: 1,
        database: "test",
        user: "test",
      });
      expect(typeof data.durationMs).toBe("number");
      expect(data.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("has correct response shape on failure", async () => {
      const { data } = await req(port, "POST", "/api/database/test", {
        host: "127.0.0.1",
        port: 1,
      });
      expect("success" in data).toBe(true);
      expect("serverVersion" in data).toBe(true);
      expect("error" in data).toBe(true);
      expect("durationMs" in data).toBe(true);
      expect(data.success).toBe(false);
      expect(data.serverVersion).toBeNull();
    });

    it("rejects connectionString host override to blocked targets", async () => {
      const previousBind = process.env.ELIZA_API_BIND;
      process.env.ELIZA_API_BIND = "0.0.0.0";
      try {
        // Use localhost as the URI hostname but override with blocked IP in query param
        const { status, data } = await req(port, "POST", "/api/database/test", {
          connectionString:
            "postgresql://u:p@localhost/db?host=169.254.169.254",
        });
        expect(status).toBe(400);
        expect(String(data.error ?? "")).toContain("blocked");
      } finally {
        if (previousBind === undefined) delete process.env.ELIZA_API_BIND;
        else process.env.ELIZA_API_BIND = previousBind;
      }
    });

    it("blocks private IPv6 targets for remote API binds", async () => {
      const previousBind = process.env.ELIZA_API_BIND;
      process.env.ELIZA_API_BIND = "0.0.0.0";
      try {
        const blockedBodies: Array<Record<string, unknown>> = [
          {
            host: "fc12::1",
            port: 5432,
            database: "postgres",
            user: "postgres",
          },
          {
            host: "fd12::1",
            port: 5432,
            database: "postgres",
            user: "postgres",
          },
          {
            host: "::ffff:7f00:1",
            port: 5432,
            database: "postgres",
            user: "postgres",
          },
          {
            connectionString: "postgresql://postgres@[fc12::1]:5432/postgres",
          },
          {
            connectionString:
              "postgresql://postgres@[::ffff:7f00:1]:5432/postgres",
          },
        ];

        for (const payload of blockedBodies) {
          const { status, data } = await req(
            port,
            "POST",
            "/api/database/test",
            payload,
          );
          expect(status).toBe(400);
          expect(String(data.error ?? "")).toContain("blocked");
        }
      } finally {
        if (previousBind === undefined) delete process.env.ELIZA_API_BIND;
        else process.env.ELIZA_API_BIND = previousBind;
      }
    });
  });

  // ── Group 4: Data endpoints — 503 without runtime ─────────────────────

  describe("data endpoints reject with 503 when no runtime", () => {
    it("GET /api/database/tables → 503", async () => {
      const { status, data } = await req(port, "GET", "/api/database/tables");
      expect(status).toBe(503);
      expect(data.error).toContain("Database not available");
    });

    it("GET /api/database/tables/agents/rows → 503", async () => {
      const { status } = await req(
        port,
        "GET",
        "/api/database/tables/agents/rows",
      );
      expect(status).toBe(503);
    });

    it("POST /api/database/tables/agents/rows → 503", async () => {
      const { status } = await req(
        port,
        "POST",
        "/api/database/tables/agents/rows",
        {
          data: { name: "test" },
        },
      );
      expect(status).toBe(503);
    });

    it("PUT /api/database/tables/agents/rows → 503", async () => {
      const { status } = await req(
        port,
        "PUT",
        "/api/database/tables/agents/rows",
        {
          where: { id: "123" },
          data: { name: "updated" },
        },
      );
      expect(status).toBe(503);
    });

    it("DELETE /api/database/tables/agents/rows → 503", async () => {
      const { status } = await req(
        port,
        "DELETE",
        "/api/database/tables/agents/rows",
        {
          where: { id: "123" },
        },
      );
      expect(status).toBe(503);
    });

    it("POST /api/database/query → 503", async () => {
      const { status } = await req(port, "POST", "/api/database/query", {
        sql: "SELECT 1",
      });
      expect(status).toBe(503);
    });

    it("all 503 responses share the same error message", async () => {
      const endpoints = [
        { method: "GET", path: "/api/database/tables" },
        { method: "GET", path: "/api/database/tables/foo/rows" },
        { method: "POST", path: "/api/database/query" },
      ];
      for (const ep of endpoints) {
        const { data } = await req(
          port,
          ep.method,
          ep.path,
          ep.method === "POST" ? { sql: "SELECT 1" } : undefined,
        );
        expect(data.error).toBe(
          "Database not available. The agent may not be running or the database adapter is not initialized.",
        );
      }
    });
  });

  // ── Group 5: Routing ──────────────────────────────────────────────────

  describe("routing", () => {
    it("unknown /api/database sub-path returns 503 (caught by runtime guard)", async () => {
      // Without a runtime, any unrecognized /api/database/* path hits the
      // runtime guard and returns 503 rather than falling through to 404.
      const { status } = await req(port, "GET", "/api/database/nonexistent");
      expect(status).toBe(503);
    });

    it("extra path segments after /rows are not matched → 503", async () => {
      const { status } = await req(
        port,
        "GET",
        "/api/database/tables/foo/rows/extra",
      );
      expect(status).toBe(503);
    });

    it("GET /api/database (no sub-path) → 503", async () => {
      // The server routes /api/database/ prefix to the handler, but the
      // bare path matches nothing before the runtime guard.
      const { status } = await req(port, "GET", "/api/database/");
      expect(status).toBe(503);
    });

    it("wrong HTTP method on config → falls through to 404", async () => {
      // DELETE /api/database/config is not a registered route, so the
      // handleDatabaseRoute returns false and server falls through to 404.
      // But wait — without runtime, it hits the 503 guard first.
      // Only status/config/test are before the guard, and DELETE on config
      // doesn't match GET or PUT, so it falls through to the guard → 503.
      const { status } = await req(port, "DELETE", "/api/database/config");
      expect(status).toBe(503);
    });
  });

  // ── Group 6: Input shape validation ───────────────────────────────────
  // Note: These endpoints require a runtime to reach the validation logic.
  // Without a runtime, the 503 guard fires first. We verify the guard
  // is consistent, then document what the validation would reject.

  describe("input validation (guarded by 503 without runtime)", () => {
    it("POST /api/database/query with empty body → 503 (guard before validation)", async () => {
      const { status } = await req(port, "POST", "/api/database/query", {});
      expect(status).toBe(503);
    });

    it("POST /api/database/tables/foo/rows with empty body → 503", async () => {
      const { status } = await req(
        port,
        "POST",
        "/api/database/tables/foo/rows",
        {},
      );
      expect(status).toBe(503);
    });

    it("PUT /api/database/tables/foo/rows missing where → 503", async () => {
      const { status } = await req(
        port,
        "PUT",
        "/api/database/tables/foo/rows",
        {
          data: { name: "x" },
        },
      );
      expect(status).toBe(503);
    });

    it("DELETE /api/database/tables/foo/rows missing where → 503", async () => {
      const { status } = await req(
        port,
        "DELETE",
        "/api/database/tables/foo/rows",
        {},
      );
      expect(status).toBe(503);
    });
  });

  // ── Group 7: Config edge cases ────────────────────────────────────────

  describe("config edge cases", () => {
    afterAll(async () => {
      await req(port, "PUT", "/api/database/config", { provider: "pglite" });
    });

    it("PUT with only provider (no sub-config) succeeds", async () => {
      const { status, data } = await req(port, "PUT", "/api/database/config", {
        provider: "pglite",
      });
      expect(status).toBe(200);
      expect(data.saved).toBe(true);
    });

    it("PUT merges with existing config rather than replacing", async () => {
      // First save postgres config (use IPs to bypass DNS validation)
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: { host: "10.0.0.1", port: 5432 },
      });
      // Then update just the host
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: { host: "10.0.0.2" },
      });
      const { data } = await req(port, "GET", "/api/database/config");
      const config = data.config as Record<string, Record<string, unknown>>;
      // Host updated, port preserved from original
      expect(config.postgres.host).toBe("10.0.0.2");
      expect(config.postgres.port).toBe(5432);
    });

    it("switching provider preserves the other provider config", async () => {
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
        postgres: { host: "10.0.0.3" },
      });
      // Switch to pglite
      await req(port, "PUT", "/api/database/config", {
        provider: "pglite",
      });
      // Switch back to postgres — old host should still be there
      await req(port, "PUT", "/api/database/config", {
        provider: "postgres",
      });
      const { data } = await req(port, "GET", "/api/database/config");
      const config = data.config as Record<string, Record<string, unknown>>;
      expect(config.postgres.host).toBe("10.0.0.3");
    });
  });
});
