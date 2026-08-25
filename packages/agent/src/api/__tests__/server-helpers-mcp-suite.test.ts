/**
 * Unit tests for MCP server configuration validation and terminal authorization helpers.
 * Exercises blocked key filtering, stdio detection, and terminal auth resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mcpServersIncludeStdio,
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
} from "../server-helpers-mcp.ts";

describe("server-helpers-mcp", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("mcpServersIncludeStdio", () => {
    it("returns false for empty servers map", () => {
      expect(mcpServersIncludeStdio({})).toBe(false);
    });

    it("returns false for non-stdio server configurations", () => {
      const servers = {
        weather: { type: "sse", url: "https://api.example.com/sse" },
        search: { type: "http", url: "https://api.example.com/mcp" },
      };
      expect(mcpServersIncludeStdio(servers)).toBe(false);
    });

    it("returns true when at least one server is stdio", () => {
      const servers = {
        remote: { type: "sse", url: "https://api.example.com/sse" },
        localGit: { type: "stdio", command: "git-mcp", args: [] },
      };
      expect(mcpServersIncludeStdio(servers)).toBe(true);
    });

    it("safely ignores non-object or invalid configs", () => {
      const servers = {
        invalid1: null,
        invalid2: "string-config",
        invalid3: ["array", "config"],
      };
      expect(mcpServersIncludeStdio(servers)).toBe(false);
    });
  });

  describe("resolveMcpServersRejection", () => {
    it("rejects blocked server names", async () => {
      const rejection = await resolveMcpServersRejection({
        __proto__: { type: "sse", url: "https://example.com" },
        constructor: { type: "sse", url: "https://example.com" },
      });
      expect(rejection).toMatch(/Invalid server name/);
    });

    it("rejects non-object server configs", async () => {
      const rejection = await resolveMcpServersRejection({
        invalidServer: "not-an-object",
      });
      expect(rejection).toBe(
        'Server "invalidServer" config must be a JSON object',
      );
    });

    it("rejects array server configs", async () => {
      const rejection = await resolveMcpServersRejection({
        invalidArray: [{ type: "stdio" }],
      });
      expect(rejection).toBe(
        'Server "invalidArray" config must be a JSON object',
      );
    });

    it("rejects configs with blocked keys deep", async () => {
      const serverPayload = JSON.parse(
        '{"badServer": {"type": "sse", "url": "https://example.com", "__proto__": {"polluted": true}}}',
      );
      const rejection = await resolveMcpServersRejection(serverPayload);
      expect(rejection).toBe('Server "badServer" contains blocked object keys');
    });

    it("returns null for valid server configs", async () => {
      const rejection = await resolveMcpServersRejection({
        github: {
          type: "sse",
          url: "https://api.github.com/mcp",
        },
      });
      expect(rejection).toBeNull();
    });
  });

  describe("resolveMcpTerminalAuthorizationRejection", () => {
    it("returns null if servers do not include stdio", () => {
      const req = { headers: {} };
      const servers = {
        sseServer: { type: "sse", url: "https://example.com" },
      };
      const result = resolveMcpTerminalAuthorizationRejection(req, servers, {});
      expect(result).toBeNull();
    });

    it("rejects with 403 when stdio is configured without terminal token or dev override", () => {
      delete process.env.ELIZA_TERMINAL_RUN_TOKEN;
      delete process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP;

      const req = { headers: {} };
      const servers = {
        localTool: { type: "stdio", command: "node", args: ["tool.js"] },
      };
      const result = resolveMcpTerminalAuthorizationRejection(req, servers, {});
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      expect(result?.reason).toContain("ELIZA_TERMINAL_RUN_TOKEN");
    });
  });
});
