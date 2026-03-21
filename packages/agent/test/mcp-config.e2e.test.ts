/**
 * E2E tests for MCP config-to-runtime attach validation (MW-07, #472).
 *
 * Exercises the MCP config write path, reject-path guards, and runtime
 * status endpoint through the real HTTP API — no mocks.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper (matches api-server.e2e.test.ts)
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
// Server lifecycle — single instance shared across all tests
// ---------------------------------------------------------------------------

let port: number;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = await startApiServer({ port: 0 });
  port = server.port;
  close = server.close;
}, 30_000);

afterAll(async () => {
  await close();
});

// ===========================================================================
// 1. MCP config write path
// ===========================================================================

describe("MCP config write path", () => {
  it("POST adds stdio server, GET returns it with redacted env", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "write-stdio",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/mcp-write"],
        env: { MY_TOKEN: "secret-value-123" },
      },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.requiresRestart).toBe(true);

    const { data: configData } = await req(port, "GET", "/api/mcp/config");
    const servers = configData.servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers["write-stdio"]).toBeDefined();
    expect(servers["write-stdio"].command).toBe("npx");

    // Env values should be redacted in GET responses
    const env = servers["write-stdio"].env as
      | Record<string, string>
      | undefined;
    if (env) {
      expect(env.MY_TOKEN).not.toBe("secret-value-123");
    }
  });

  it("POST adds remote (streamable-http) server with URL, verifies persistence", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "write-remote",
      config: {
        type: "streamable-http",
        url: "https://93.184.216.34/mcp",
      },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const { data: configData } = await req(port, "GET", "/api/mcp/config");
    const servers = configData.servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers["write-remote"]).toBeDefined();
    expect(servers["write-remote"].type).toBe("streamable-http");
    expect(servers["write-remote"].url).toBe("https://93.184.216.34/mcp");
  });

  it("PUT replaces entire servers config, old entries removed", async () => {
    // Seed a server first
    await req(port, "POST", "/api/mcp/config/server", {
      name: "old-entry",
      config: { type: "stdio", command: "npx", args: ["-y", "@test/old"] },
    });

    const newServers = {
      "put-a": { type: "stdio", command: "node", args: ["server.js"] },
      "put-b": {
        type: "streamable-http",
        url: "https://93.184.216.34/mcp-b",
      },
    };

    const { status, data } = await req(port, "PUT", "/api/mcp/config", {
      servers: newServers,
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    const { data: configData } = await req(port, "GET", "/api/mcp/config");
    const servers = configData.servers as Record<string, unknown>;
    expect(servers["put-a"]).toBeDefined();
    expect(servers["put-b"]).toBeDefined();
    expect(servers["old-entry"]).toBeUndefined();
  });

  it("DELETE removes a server, verifies it is gone from GET", async () => {
    await req(port, "POST", "/api/mcp/config/server", {
      name: "del-target",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/del-target"],
      },
    });

    const { status, data } = await req(
      port,
      "DELETE",
      "/api/mcp/config/server/del-target",
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.requiresRestart).toBe(true);

    const { data: configData } = await req(port, "GET", "/api/mcp/config");
    const servers = configData.servers as Record<string, unknown>;
    expect(servers["del-target"]).toBeUndefined();
  });

  it("POST rejects missing config object (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "no-config",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Server config object is required");
  });

  it("POST rejects array config (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "array-config",
      config: [{ type: "stdio", command: "npx" }],
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Server config object is required");
  });

  it("DELETE is idempotent for nonexistent server name", async () => {
    const { status, data } = await req(
      port,
      "DELETE",
      "/api/mcp/config/server/no-such-server-xyz",
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});

// ===========================================================================
// 2. MCP reject-path: server name guards
// ===========================================================================

describe("MCP reject-path: server name guards", () => {
  it("rejects empty server name (400)", async () => {
    const { status } = await req(port, "POST", "/api/mcp/config/server", {
      name: "",
      config: { type: "stdio", command: "npx" },
    });
    expect(status).toBe(400);
  });

  it.each([
    "__proto__",
    "constructor",
    "prototype",
  ])("rejects reserved name %s via POST (400)", async (name) => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name,
      config: { type: "stdio", command: "npx" },
    });
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it.each([
    "__proto__",
    "constructor",
    "prototype",
  ])("rejects reserved name %s via DELETE path (400)", async (name) => {
    const { status } = await req(
      port,
      "DELETE",
      `/api/mcp/config/server/${name}`,
    );
    expect(status).toBe(400);
  });
});

// ===========================================================================
// 3. MCP reject-path: stdio validation
// ===========================================================================

describe("MCP reject-path: stdio validation", () => {
  it("rejects non-allowlisted command (400)", async () => {
    for (const command of ["bash", "curl", "sh", "wget"]) {
      const { status, data } = await req(
        port,
        "POST",
        "/api/mcp/config/server",
        {
          name: `bad-cmd-${command}`,
          config: { type: "stdio", command },
        },
      );
      expect(status).toBe(400);
      expect(data.error).toContain("not allowed");
    }
  });

  it("rejects path-based command (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "path-cmd",
      config: { type: "stdio", command: "/usr/bin/npx" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("bare executable name");
  });

  it("rejects missing command for stdio type (400)", async () => {
    const { status } = await req(port, "POST", "/api/mcp/config/server", {
      name: "no-cmd",
      config: { type: "stdio" },
    });
    expect(status).toBe(400);
  });

  it("rejects blocked interpreter flags via node (400)", async () => {
    for (const flag of ["-e", "--eval", "-r", "--require"]) {
      const { status, data } = await req(
        port,
        "POST",
        "/api/mcp/config/server",
        {
          name: `bad-flag-${flag}`,
          config: { type: "stdio", command: "node", args: [flag, "payload"] },
        },
      );
      expect(status).toBe(400);
      expect(data.error).toContain(flag);
    }
  });

  it("rejects blocked package runner flags via npx (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "npx-c-flag",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-c", "malicious-script"],
      },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("-c");
  });

  it("rejects blocked container flags via docker (400)", async () => {
    for (const flag of ["--privileged", "-v"]) {
      const { status, data } = await req(
        port,
        "POST",
        "/api/mcp/config/server",
        {
          name: `docker-${flag}`,
          config: {
            type: "stdio",
            command: "docker",
            args: ["run", flag, "image"],
          },
        },
      );
      expect(status).toBe(400);
      expect(data.error).toContain(flag);
    }
  });

  it("rejects deno eval subcommand (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "deno-eval",
      config: {
        type: "stdio",
        command: "deno",
        args: ["eval", "Deno.exit()"],
      },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("eval");
  });
});

// ===========================================================================
// 4. MCP reject-path: remote & env validation
// ===========================================================================

describe("MCP reject-path: remote & env validation", () => {
  it("rejects invalid config type (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "bad-type",
      config: { type: "websocket" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("Invalid config type");
  });

  it("rejects missing URL for remote server type (400)", async () => {
    const { status } = await req(port, "POST", "/api/mcp/config/server", {
      name: "no-url",
      config: { type: "streamable-http" },
    });
    expect(status).toBe(400);
  });

  it("rejects non-http protocol URL (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "file-url",
      config: { type: "streamable-http", url: "file:///etc/passwd" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("http");
  });

  it("rejects localhost URL for SSRF prevention (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "ssrf-localhost",
      config: { type: "streamable-http", url: "http://localhost:3000/mcp" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("blocked");
  });

  it("rejects blocked env keys (400)", async () => {
    for (const key of ["NODE_OPTIONS", "LD_PRELOAD"]) {
      const { status, data } = await req(
        port,
        "POST",
        "/api/mcp/config/server",
        {
          name: `env-${key}`,
          config: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@test/env"],
            env: { [key]: "malicious" },
          },
        },
      );
      expect(status).toBe(400);
      expect(data.error).toContain("not allowed");
    }
  });

  it("rejects non-string env values (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "env-non-string",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/env"],
        env: { SAFE_KEY: 12345 },
      },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("must be a string");
  });
});

// ===========================================================================
// 5. MCP reject-path: PUT validation
// ===========================================================================

describe("MCP reject-path: PUT validation", () => {
  it("rejects array servers value (400)", async () => {
    const { status, data } = await req(port, "PUT", "/api/mcp/config", {
      servers: [{ type: "stdio", command: "npx" }],
    });
    expect(status).toBe(400);
    expect(data.error).toContain("servers must be a JSON object");
  });

  it("rejects null servers value (400)", async () => {
    const { status, data } = await req(port, "PUT", "/api/mcp/config", {
      servers: null,
    });
    expect(status).toBe(400);
    expect(data.error).toContain("servers must be a JSON object");
  });

  it("rejects PUT with invalid server config inside servers map (400)", async () => {
    const { status, data } = await req(port, "PUT", "/api/mcp/config", {
      servers: {
        "bad-server": { type: "stdio", command: "curl" },
      },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not allowed");
  });
});

// ===========================================================================
// 6. MCP reject-path: deep prototype pollution & config inclusion
// ===========================================================================

describe("MCP reject-path: prototype pollution & config inclusion", () => {
  it("rejects $include key in server config (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "include-attack",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/ok"],
        $include: "/etc/passwd",
      },
    });
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it("rejects constructor as server name inside PUT servers map (400)", async () => {
    const { status, data } = await req(port, "PUT", "/api/mcp/config", {
      servers: {
        constructor: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@test/ok"],
        },
      },
    });
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it("rejects $include key nested in env object via POST (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "env-include",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/ok"],
        env: { $include: "/etc/shadow" },
      },
    });
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it("rejects $include as server name via POST (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "$include",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/ok"],
      },
    });
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it("rejects cloud metadata SSRF target via remote URL (400)", async () => {
    const { status, data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "ssrf-metadata",
      config: {
        type: "streamable-http",
        url: "http://metadata.google.internal/computeMetadata/v1/",
      },
    });
    expect(status).toBe(400);
    expect(typeof data.error).toBe("string");
  });

  it("does not reject http config type at type-validation stage", async () => {
    // Uses a non-resolving host — DNS check fails but the type itself is accepted
    const { data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "http-type-test",
      config: {
        type: "http",
        url: "https://mcp.example.com/api",
      },
    });
    // Error should be DNS resolution, not "Invalid config type"
    const errStr = String(data.error ?? "");
    expect(errStr).not.toContain("Invalid config type");
  });

  it("does not reject sse config type at type-validation stage", async () => {
    const { data } = await req(port, "POST", "/api/mcp/config/server", {
      name: "sse-type-test",
      config: {
        type: "sse",
        url: "https://mcp.example.com/events",
      },
    });
    const errStr = String(data.error ?? "");
    expect(errStr).not.toContain("Invalid config type");
  });

  it("handles URL-encoded server name in DELETE path", async () => {
    const name = "server with spaces";
    await req(port, "POST", "/api/mcp/config/server", {
      name,
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/spaces"],
      },
    });

    const { status, data } = await req(
      port,
      "DELETE",
      `/api/mcp/config/server/${encodeURIComponent(name)}`,
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);

    // Verify it was removed
    const { data: configData } = await req(port, "GET", "/api/mcp/config");
    const servers = configData.servers as Record<string, unknown>;
    expect(servers[name]).toBeUndefined();
  });
});

// ===========================================================================
// 7. MCP runtime status
// ===========================================================================

describe("MCP runtime status", () => {
  it("GET /api/mcp/status returns { ok: true, servers: [] } without runtime", async () => {
    const { status, data } = await req(port, "GET", "/api/mcp/status");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.servers)).toBe(true);
  });

  it("servers array entries have correct shape when present", async () => {
    const { data } = await req(port, "GET", "/api/mcp/status");
    const servers = data.servers as Array<Record<string, unknown>>;
    for (const server of servers) {
      expect(typeof server.name).toBe("string");
      expect(typeof server.status).toBe("string");
      expect(typeof server.toolCount).toBe("number");
      expect(typeof server.resourceCount).toBe("number");
    }
  });

  it("status endpoint remains functional after config mutations", async () => {
    // Mutate config
    await req(port, "POST", "/api/mcp/config/server", {
      name: "status-check-server",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@test/status-check"],
      },
    });

    // Status should still work
    const { status, data } = await req(port, "GET", "/api/mcp/status");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.servers)).toBe(true);

    // Clean up
    await req(port, "DELETE", "/api/mcp/config/server/status-check-server");
  });
});
