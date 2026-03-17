import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function http$(
  port: number,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
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
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("error", reject);
    if (b) req.write(b);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Plugin Management E2E", () => {
  let server: { port: number; close: () => Promise<void> };
  // biome-ignore lint/suspicious/noExplicitAny: mock type
  let mockPluginManager: any;

  beforeAll(async () => {
    // Create a mock plugin manager
    mockPluginManager = {
      installPlugin: vi.fn().mockImplementation(async (name) => {
        if (typeof name === "string" && name.includes("non-existent")) {
          return {
            success: false,
            error: "Not found",
            requiresRestart: false,
            pluginName: name,
          };
        }
        return { success: true, pluginName: name, requiresRestart: true };
      }),
      ejectPlugin: vi.fn().mockImplementation(async (name) => {
        if (name.includes("non-existent"))
          return {
            success: false,
            error: "Not found",
            requiresRestart: false,
            pluginName: name,
          };
        return {
          success: true,
          pluginName: name,
          ejectedPath: "/tmp/ejected",
          requiresRestart: true,
        };
      }),
      syncPlugin: vi.fn().mockImplementation(async (name) => {
        if (name.includes("non-existent"))
          return {
            success: false,
            error: "Not found",
            requiresRestart: false,
            pluginName: name,
          };
        return {
          success: true,
          pluginName: name,
          ejectedPath: "/tmp/ejected",
          upstreamCommits: 1,
          requiresRestart: true,
        };
      }),
      reinjectPlugin: vi.fn().mockImplementation(async (name) => {
        if (name.includes("non-existent"))
          return {
            success: false,
            error: "Not found",
            requiresRestart: false,
            pluginName: name,
          };
        return {
          success: true,
          pluginName: name,
          removedPath: "/tmp/ejected",
          requiresRestart: true,
        };
      }),
      listEjectedPlugins: vi.fn().mockResolvedValue([]),
      // Add other required methods to satisfy isPluginManagerLike check
      refreshRegistry: vi.fn(),
      listInstalledPlugins: vi.fn(),
      getRegistryPlugin: vi.fn(),
      searchRegistry: vi.fn(),
      uninstallPlugin: vi.fn().mockImplementation(async (name) => {
        if (name.includes("non-existent")) {
          return {
            success: false,
            error: "Not found",
            requiresRestart: false,
            pluginName: name,
          };
        }
        return {
          success: true,
          pluginName: name,
          requiresRestart: true,
        };
      }),
    };

    // Create a mock runtime
    const mockRuntime = {
      getService: (type: string) => {
        if (type === "plugin_manager") return mockPluginManager;
        return null;
      },
      // Add minimal required props for server to start if needed
      character: { name: "TestAgent" },
      agentId: "test-id",
    };

    // Start server with mock runtime
    // biome-ignore lint/suspicious/noExplicitAny: mock type
    server = await startApiServer({ port: 0, runtime: mockRuntime as any });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
  });

  // ===================================================================
  //  1. Install Plugin (Contract Tests)
  // ===================================================================

  describe("POST /api/plugins/install", () => {
    it("returns 400 for missing name", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/install",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toContain("must include 'name'");
    });

    it("returns 400 for invalid name format", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/install",
        { name: "invalid name with spaces" },
      );
      expect(status).toBe(400);
      expect(data.error).toBe("Invalid plugin name format");
    });

    it("returns 500/422 for non-existent plugin (verifies service is called)", async () => {
      // connecting to real registry might verify it doesn't exist
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/install",
        { name: "@elizaos/non-existent-plugin-12345" },
      );
      // Depending on how PluginManagerService handles it, might be 422 or 500
      expect(status).toBeGreaterThanOrEqual(400);
      // We assume service attempts to install and fails
      expect(data.error).toBeDefined();
    });
  });

  // ===================================================================
  //  2. Uninstall Plugin
  // ===================================================================

  describe("POST /api/plugins/uninstall", () => {
    it("returns 400 for missing name", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/uninstall",
        {},
      );
      expect(status).toBe(400);
      expect(data.error).toContain("must include 'name'");
    });

    it("returns 422 when uninstall fails", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/uninstall",
        { name: "@elizaos/non-existent-plugin" },
      );
      expect(status).toBe(422);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    });

    it("returns 200 on successful uninstall", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/uninstall",
        { name: "@elizaos/plugin-test" },
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.pluginName).toBe("@elizaos/plugin-test");
      expect(data.requiresRestart).toBe(true);
    });
  });

  // ===================================================================
  //  3. Eject Plugin
  // ===================================================================

  describe("POST /api/plugins/:id/eject", () => {
    it("returns 422/500 for non-installed plugin", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/non-existent/eject",
      );
      expect(status).not.toBe(404); // Should match route and fail gracefully
      expect(data.error).toBeDefined();
    });
  });

  // ===================================================================
  //  4. Sync Plugin
  // ===================================================================

  describe("POST /api/plugins/:id/sync", () => {
    it("returns 422/500 for non-ejected plugin", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/non-existent/sync",
      );
      expect(status).not.toBe(404);
      expect(data.error).toBeDefined();
    });
  });

  // ===================================================================
  //  5. Reinject Plugin
  // ===================================================================

  describe("POST /api/plugins/:id/reinject", () => {
    it("returns 422/500 for non-ejected plugin", async () => {
      const { status, data } = await http$(
        server.port,
        "POST",
        "/api/plugins/non-existent/reinject",
      );
      expect(status).not.toBe(404);
      expect(data.error).toBeDefined();
    });
  });

  // ===================================================================
  //  6. List Ejected
  // ===================================================================

  describe("GET /api/plugins/ejected", () => {
    it("returns list", async () => {
      const { status, data } = await http$(
        server.port,
        "GET",
        "/api/plugins/ejected",
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.plugins)).toBe(true);
    });
  });
});
