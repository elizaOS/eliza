/**
 * Real integration test for MCP auto-inherit: write a config file, point
 * ELIZA_CONFIG_PATH at it, and assert readConfigMcpServers converts the
 * dashboard-persisted `mcp.servers` object into the ACP `session/new.mcpServers`
 * array shape. No mocks — it exercises the real file read + conversion.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigMcpServers } from "../services/config-env";

let dir: string;
let prevPath: string | undefined;

beforeEach(() => {
  prevPath = process.env.ELIZA_CONFIG_PATH;
  dir = mkdtempSync(join(tmpdir(), "acp-mcp-"));
});

afterEach(() => {
  if (prevPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = prevPath;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function writeConfig(obj: unknown): void {
  const p = join(dir, "eliza.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.ELIZA_CONFIG_PATH = p;
}

describe("readConfigMcpServers — auto-inherit parent MCP servers", () => {
  it("returns undefined when nothing is configured (env-var fallback applies)", () => {
    writeConfig({});
    expect(readConfigMcpServers()).toBeUndefined();
    writeConfig({ mcp: {} });
    expect(readConfigMcpServers()).toBeUndefined();
    writeConfig({ mcp: { servers: {} } });
    expect(readConfigMcpServers()).toBeUndefined();
  });

  it("converts a stdio server (env record -> name/value array)", () => {
    writeConfig({
      mcp: {
        servers: {
          fs: {
            command: "mcp-fs",
            args: ["--root", "/tmp"],
            env: { TOKEN: "x" },
          },
        },
      },
    });
    const out = readConfigMcpServers();
    expect(out).toEqual([
      {
        name: "fs",
        command: "mcp-fs",
        args: ["--root", "/tmp"],
        env: [{ name: "TOKEN", value: "x" }],
      },
    ]);
  });

  it("converts an http server (url + headers record)", () => {
    writeConfig({
      mcp: {
        servers: {
          search: {
            type: "http",
            url: "https://mcp.example/x",
            headers: { Authorization: "Bearer y" },
          },
        },
      },
    });
    const out = readConfigMcpServers();
    expect(out).toEqual([
      {
        name: "search",
        type: "http",
        url: "https://mcp.example/x",
        headers: [{ name: "Authorization", value: "Bearer y" }],
      },
    ]);
  });

  it("drops malformed entries (no command and no url)", () => {
    writeConfig({
      mcp: { servers: { bad: { foo: "bar" }, ok: { command: "x" } } },
    });
    const out = readConfigMcpServers();
    expect(out).toHaveLength(1);
    expect(out?.[0]?.name).toBe("ok");
  });

  it("returns undefined for a missing/unreadable config (never throws)", () => {
    process.env.ELIZA_CONFIG_PATH = join(dir, "does-not-exist.json");
    expect(readConfigMcpServers()).toBeUndefined();
  });
});
