/**
 * Tests env-declared MCP server discovery: `MCP_SERVER_<NAME>_URL` /
 * `MCP_SERVER_<NAME>_TYPE` variables merge on top of configured
 * `settings.mcp.servers`. Deterministic unit harness — a real McpService
 * instance with a stubbed runtime and a scoped process.env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpService } from "../src/service";
import type { McpServerConfig, McpSettings } from "../src/types";

type SettingsInternals = {
  runtime: { getSetting: (key: string) => unknown; character: { settings?: unknown } };
  getMcpSettings: () => McpSettings | undefined;
};

const ENV_KEYS = [
  "MCP_SERVER_ROUTER_URL",
  "MCP_SERVER_ROUTER_TYPE",
  "MCP_SERVER_Docs_URL",
  "MCP_SERVER_LEGACY_URL",
  "MCP_SERVER_LEGACY_TYPE",
  "MCP_SERVER_BLANK_URL",
];

function serviceWith(settings: {
  runtimeSetting?: unknown;
  characterMcp?: unknown;
}): SettingsInternals {
  const service = new McpService() as unknown as SettingsInternals;
  service.runtime = {
    getSetting: vi.fn((key: string) => (key === "mcp" ? settings.runtimeSetting : undefined)),
    character: {
      settings:
        settings.characterMcp === undefined ? {} : ({ mcp: settings.characterMcp } as unknown),
    },
  };
  return service;
}

describe("env-declared MCP servers", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns configured settings unchanged when no env servers are declared", () => {
    const configured: McpSettings = {
      servers: { local: { type: "stdio", command: "bun" } },
    };
    const service = serviceWith({ runtimeSetting: configured });
    expect(service.getMcpSettings()).toBe(configured);
  });

  it("returns undefined when neither config nor env declares servers", () => {
    const service = serviceWith({});
    expect(service.getMcpSettings()).toBeUndefined();
  });

  it("builds settings from env alone, lowercasing the name and defaulting to streamable-http", () => {
    process.env.MCP_SERVER_Docs_URL = " https://mcp.example.com/docs ";
    const service = serviceWith({});
    const settings = service.getMcpSettings();
    expect(settings?.servers).toEqual({
      docs: { type: "streamable-http", url: "https://mcp.example.com/docs" },
    });
  });

  it("honors an explicit sse/http type and falls back on anything else", () => {
    process.env.MCP_SERVER_LEGACY_URL = "https://mcp.example.com/legacy";
    process.env.MCP_SERVER_LEGACY_TYPE = "SSE";
    process.env.MCP_SERVER_ROUTER_URL = "https://mcp.example.com/router";
    process.env.MCP_SERVER_ROUTER_TYPE = "websocket";
    const service = serviceWith({});
    const servers = service.getMcpSettings()?.servers as Record<string, McpServerConfig>;
    expect(servers.legacy.type).toBe("sse");
    expect(servers.router.type).toBe("streamable-http");
  });

  it("skips blank URL values", () => {
    process.env.MCP_SERVER_BLANK_URL = "   ";
    const service = serviceWith({});
    expect(service.getMcpSettings()).toBeUndefined();
  });

  it("merges env servers over configured ones, env winning on a name collision", () => {
    process.env.MCP_SERVER_ROUTER_URL = "https://mcp.example.com/env-wins";
    const configured: McpSettings = {
      maxRetries: 5,
      servers: {
        router: { type: "sse", url: "https://mcp.example.com/configured" },
        local: { type: "stdio", command: "bun" },
      },
    };
    const service = serviceWith({ runtimeSetting: configured });
    const settings = service.getMcpSettings();
    expect(settings?.maxRetries).toBe(5);
    expect(settings?.servers.local).toEqual({ type: "stdio", command: "bun" });
    expect(settings?.servers.router).toEqual({
      type: "streamable-http",
      url: "https://mcp.example.com/env-wins",
    });
  });

  it("still fails fast on malformed configured settings even when env servers exist", () => {
    process.env.MCP_SERVER_ROUTER_URL = "https://mcp.example.com/router";
    const service = serviceWith({
      runtimeSetting: { servers: { bad: { type: "carrier-pigeon" } } },
    });
    expect(() => service.getMcpSettings()).toThrowError(/MCP settings are malformed/);
  });

  it("reads character-level settings and merges env on top", () => {
    process.env.MCP_SERVER_ROUTER_URL = "https://mcp.example.com/router";
    const service = serviceWith({
      characterMcp: { servers: { local: { type: "stdio", command: "bun" } } },
    });
    const settings = service.getMcpSettings();
    expect(Object.keys(settings?.servers ?? {}).sort()).toEqual(["local", "router"]);
  });
});
