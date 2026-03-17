/**
 * E2E tests for the Permissions API endpoints.
 *
 * Covers:
 * - GET /api/permissions - Get all permission states
 * - GET /api/permissions/:id - Get single permission state
 * - POST /api/permissions/refresh - Refresh permission states
 * - POST /api/permissions/:id/request - Request a permission
 * - POST /api/permissions/:id/open-settings - Open system settings
 * - PUT /api/permissions/shell - Toggle shell access
 * - PUT /api/permissions/state - Update permission states
 *
 * NO MOCKS - all tests spin up a real HTTP server.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

function saveEnv(...keys: string[]): { restore: () => void } {
  const prev = new Map<string, string | undefined>();
  for (const key of keys) prev.set(key, process.env[key]);
  return {
    restore: () => {
      for (const [key, value] of prev) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ReqOptions {
  headers?: Record<string, string>;
}

function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  opts?: ReqOptions,
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
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
          ...(opts?.headers ?? {}),
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
// Test suite
// ---------------------------------------------------------------------------

describe("Permissions API E2E", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // Start server without auth token for simpler testing
    const result = await startApiServer({ port: 0 });
    port = result.port;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/permissions
  // ─────────────────────────────────────────────────────────────────────────

  describe("GET /api/permissions", () => {
    it("returns permission states and platform info", async () => {
      const { status, data } = await req(port, "GET", "/api/permissions");
      expect(status).toBe(200);
      expect(data).toHaveProperty("_platform");
      expect(data).toHaveProperty("_shellEnabled");
      expect(typeof data._platform).toBe("string");
      expect(typeof data._shellEnabled).toBe("boolean");
    });

    it("returns permissions as an object", async () => {
      const { data } = await req(port, "GET", "/api/permissions");
      expect(typeof data).toBe("object");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/permissions/:id
  // ─────────────────────────────────────────────────────────────────────────

  describe("GET /api/permissions/:id", () => {
    it("returns permission state for unknown permission ID (may be not-applicable)", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/permissions/invalid-permission",
      );
      // Server returns a state for any permission ID, even invalid ones
      // It will be marked as not-applicable or have some default state
      expect(status).toBe(200);
      expect(data).toHaveProperty("id", "invalid-permission");
    });

    it("returns permission state for valid ID: microphone", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/permissions/microphone",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("id", "microphone");
      expect(data).toHaveProperty("status");
      expect([
        "granted",
        "denied",
        "not-determined",
        "restricted",
        "not-applicable",
      ]).toContain(data.status);
    });

    it("returns permission state for valid ID: camera", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/permissions/camera",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("id", "camera");
      expect(data).toHaveProperty("status");
    });

    it("returns permission state for valid ID: shell", async () => {
      const { status, data } = await req(port, "GET", "/api/permissions/shell");
      expect(status).toBe(200);
      expect(data).toHaveProperty("enabled");
      expect(data).toHaveProperty("id", "shell");
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("permission");
      const permission = data.permission as Record<string, unknown>;
      expect(permission).toHaveProperty("id", "shell");
      expect(permission).toHaveProperty("status");
      if (data.enabled === true) expect(permission.status).toBe("granted");
      if (data.enabled === false) expect(permission.status).toBe("denied");
    });

    it("returns permission state for valid ID: accessibility", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/permissions/accessibility",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("id", "accessibility");
      expect(data).toHaveProperty("status");
    });

    it("returns permission state for valid ID: screen-recording", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/permissions/screen-recording",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("id", "screen-recording");
      expect(data).toHaveProperty("status");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/permissions/refresh
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /api/permissions/refresh", () => {
    it("returns success with IPC action indicator", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/refresh",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("message");
      expect(data).toHaveProperty("action", "ipc:permissions:refresh");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/permissions/:id/request
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /api/permissions/:id/request", () => {
    it("returns IPC action for microphone request", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/microphone/request",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("message");
      expect(data).toHaveProperty(
        "action",
        "ipc:permissions:request:microphone",
      );
    });

    it("returns IPC action for camera request", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/camera/request",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("action", "ipc:permissions:request:camera");
    });

    it("returns IPC action for accessibility request", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/accessibility/request",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty(
        "action",
        "ipc:permissions:request:accessibility",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/permissions/:id/open-settings
  // ─────────────────────────────────────────────────────────────────────────

  describe("POST /api/permissions/:id/open-settings", () => {
    it("returns IPC action for opening microphone settings", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/microphone/open-settings",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("message");
      expect(data).toHaveProperty(
        "action",
        "ipc:permissions:openSettings:microphone",
      );
    });

    it("returns IPC action for opening camera settings", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/camera/open-settings",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty(
        "action",
        "ipc:permissions:openSettings:camera",
      );
    });

    it("returns IPC action for opening accessibility settings", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/permissions/accessibility/open-settings",
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty(
        "action",
        "ipc:permissions:openSettings:accessibility",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /api/permissions/shell
  // ─────────────────────────────────────────────────────────────────────────

  describe("PUT /api/permissions/shell", () => {
    it("enables shell access", async () => {
      const { status, data } = await req(
        port,
        "PUT",
        "/api/permissions/shell",
        { enabled: true },
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("shellEnabled", true);
    });

    it("disables shell access", async () => {
      const { status, data } = await req(
        port,
        "PUT",
        "/api/permissions/shell",
        { enabled: false },
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("shellEnabled", false);
    });

    it("persists shell enabled state", async () => {
      // Disable
      await req(port, "PUT", "/api/permissions/shell", { enabled: false });

      // Check state persisted
      const { data: perms } = await req(port, "GET", "/api/permissions");
      expect(perms._shellEnabled).toBe(false);

      // Re-enable
      await req(port, "PUT", "/api/permissions/shell", { enabled: true });

      // Check state persisted
      const { data: perms2 } = await req(port, "GET", "/api/permissions");
      expect(perms2._shellEnabled).toBe(true);
    });

    it("returns 400 for missing body", async () => {
      const { status } = await req(port, "PUT", "/api/permissions/shell");
      expect(status).toBe(400);
    });

    it("blocks terminal execution when shell access is disabled", async () => {
      await req(port, "PUT", "/api/permissions/shell", { enabled: false });
      const { status, data } = await req(port, "POST", "/api/terminal/run", {
        command: "echo test",
      });
      expect(status).toBe(403);
      expect(data).toHaveProperty("error", "Shell access is disabled");
      await req(port, "PUT", "/api/permissions/shell", { enabled: true });
    });

    it("rejects multiline terminal commands", async () => {
      await req(port, "PUT", "/api/permissions/shell", { enabled: true });
      const { status, data } = await req(port, "POST", "/api/terminal/run", {
        command: "echo test\nwhoami",
      });
      expect(status).toBe(400);
      expect(data).toHaveProperty(
        "error",
        "Command must be a single line without control characters",
      );
    });

    it("rejects terminal commands containing null bytes", async () => {
      await req(port, "PUT", "/api/permissions/shell", { enabled: true });
      const { status, data } = await req(port, "POST", "/api/terminal/run", {
        command: "echo test\u0000",
      });
      expect(status).toBe(400);
      expect(data).toHaveProperty(
        "error",
        "Command must be a single line without control characters",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /api/permissions/state
  // ─────────────────────────────────────────────────────────────────────────

  describe("PUT /api/permissions/state", () => {
    it("updates permission states from Electron", async () => {
      const mockPermissions = {
        microphone: {
          id: "microphone",
          status: "granted",
          lastChecked: Date.now(),
          canRequest: false,
        },
        camera: {
          id: "camera",
          status: "denied",
          lastChecked: Date.now(),
          canRequest: true,
        },
      };

      const { status, data } = await req(
        port,
        "PUT",
        "/api/permissions/state",
        {
          permissions: mockPermissions,
        },
      );

      expect(status).toBe(200);
      expect(data).toHaveProperty("updated", true);
      expect(data).toHaveProperty("permissions");
    });

    it("returns 400 for missing body", async () => {
      const { status } = await req(port, "PUT", "/api/permissions/state");
      expect(status).toBe(400);
    });

    it("allows empty permissions object", async () => {
      const { status, data } = await req(
        port,
        "PUT",
        "/api/permissions/state",
        {
          permissions: {},
        },
      );
      expect(status).toBe(200);
      expect(data).toHaveProperty("updated", true);
    });

    it("auto-enables capabilities when their OS permissions are granted", async () => {
      const mockPermissions = {
        accessibility: {
          id: "accessibility",
          status: "granted",
          lastChecked: Date.now(),
          canRequest: false,
        },
        "screen-recording": {
          id: "screen-recording",
          status: "granted",
          lastChecked: Date.now(),
          canRequest: false,
        },
      };

      const { status } = await req(port, "PUT", "/api/permissions/state", {
        permissions: mockPermissions,
      });
      expect(status).toBe(200);

      // Verify config was updated via the GET /api/config route (simulated by reading config if possible, or we could just trust the server side logic, but let's test it)
      // Since this is an E2E test of the API, we can fetch the config and verify plugins.entries
      const { data: configData } = await req(port, "GET", "/api/config");
      const plugins = configData.plugins as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      expect(plugins?.entries?.browser?.enabled).toBe(true);
      expect(plugins?.entries?.computeruse?.enabled).toBe(true);
      expect(plugins?.entries?.vision?.enabled).toBe(true);
    });

    // Use a fresh test server to avoid config bleeding
    it("does not auto-enable capabilities that are explicitly disabled", async () => {
      // Start a fresh test server to ensure clean config state
      const { port: cleanPort, close: cleanClose } = await startApiServer({
        port: 0,
      });
      try {
        const { status: configSetupStatus } = await req(
          cleanPort,
          "PUT",
          "/api/config",
          {
            plugins: {
              entries: {
                browser: { enabled: false },
                computeruse: { enabled: false },
                vision: { enabled: false },
              },
            },
          },
        );
        expect(configSetupStatus).toBe(200);

        const mockPermissions = {
          accessibility: {
            id: "accessibility",
            status: "granted",
            lastChecked: Date.now(),
            canRequest: false,
          },
          "screen-recording": {
            id: "screen-recording",
            status: "granted",
            lastChecked: Date.now(),
            canRequest: false,
          },
        };

        const { status } = await req(
          cleanPort,
          "PUT",
          "/api/permissions/state",
          {
            permissions: mockPermissions,
          },
        );
        expect(status).toBe(200);

        const { data: configData } = await req(cleanPort, "GET", "/api/config");
        const plugins = configData.plugins as Record<
          string,
          Record<string, Record<string, unknown>>
        >;
        expect(plugins?.entries?.browser?.enabled).toBe(false);
        expect(plugins?.entries?.computeruse?.enabled).toBe(false);
        expect(plugins?.entries?.vision?.enabled).toBe(false);
      } finally {
        await cleanClose();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge cases and error handling
  // ─────────────────────────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("handles malformed permission ID with special characters", async () => {
      const { status } = await req(
        port,
        "GET",
        "/api/permissions/../../etc/passwd",
      );
      // Should be rejected as invalid or not found
      expect([400, 404]).toContain(status);
    });

    it("handles empty permission ID", async () => {
      const { status } = await req(port, "GET", "/api/permissions/");
      // Trailing slash means empty ID
      expect([400, 404]).toContain(status);
    });

    it("handles permission ID with slash", async () => {
      const { status } = await req(
        port,
        "GET",
        "/api/permissions/screen/recording",
      );
      expect([400, 404]).toContain(status);
    });
  });
});

describe("Permissions API auth access", () => {
  const TEST_TOKEN = "permissions-auth-token";
  let port: number;
  let close: () => Promise<void>;
  let envBackup: { restore: () => void };

  beforeAll(async () => {
    envBackup = saveEnv("MILADY_API_TOKEN");
    process.env.MILADY_API_TOKEN = TEST_TOKEN;
    const result = await startApiServer({ port: 0 });
    port = result.port;
    close = result.close;
  });

  afterAll(async () => {
    await close();
    envBackup.restore();
  });

  it("blocks unauthenticated access to permissions endpoints", async () => {
    const { status: s1 } = await req(port, "GET", "/api/permissions");
    const { status: s2 } = await req(port, "POST", "/api/permissions/refresh");
    const { status: s3 } = await req(
      port,
      "POST",
      "/api/permissions/microphone/request",
    );
    expect(s1).toBe(401);
    expect(s2).toBe(401);
    expect(s3).toBe(401);
  });

  it("allows authenticated access to permissions endpoints", async () => {
    const auth = { headers: { Authorization: `Bearer ${TEST_TOKEN}` } };
    const { status: s1 } = await req(
      port,
      "GET",
      "/api/permissions",
      undefined,
      auth,
    );
    const { status: s2 } = await req(
      port,
      "POST",
      "/api/permissions/refresh",
      undefined,
      auth,
    );
    const { status: s3, data } = await req(
      port,
      "POST",
      "/api/permissions/microphone/request",
      undefined,
      auth,
    );
    expect(s1).toBe(200);
    expect(s2).toBe(200);
    expect(s3).toBe(200);
    expect(data).toHaveProperty("action", "ipc:permissions:request:microphone");
  });
});
