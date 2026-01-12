import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Helper function to check if a command exists
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Integration tests for MCP server connectivity.
 * These tests require real MCP servers to be available.
 *
 * To run these tests, you need:
 * 1. Node.js installed
 * 2. npx available in PATH
 *
 * The tests use the official MCP filesystem server as a test target.
 */

describe("MCP Server Integration", () => {
  describe("StdioClientTransport", () => {
    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    afterAll(async () => {
      if (transport) {
        await transport.close().catch(() => {});
      }
      if (client) {
        await client.close().catch(() => {});
      }
    });

    it("should connect to a stdio MCP server", async () => {
      // Skip if npx is not available
      if (!commandExists("npx")) {
        console.log("Skipping test: npx not available");
        return;
      }

      // Create transport to the filesystem MCP server
      transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        stderr: "pipe",
      });

      client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

      // Connect should succeed
      await client.connect(transport);

      // Should be able to list tools
      const toolsResponse = await client.listTools();
      expect(toolsResponse).toBeDefined();
      expect(Array.isArray(toolsResponse.tools)).toBe(true);

      // Close gracefully
      await transport.close();
      await client.close();
      transport = null;
      client = null;
    }, 30000);

    it("should handle server errors gracefully", async () => {
      // Try to connect to a non-existent server
      const badTransport = new StdioClientTransport({
        command: "non-existent-command-that-should-fail",
        args: [],
        stderr: "pipe",
      });

      const badClient = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

      // Connection should fail
      let errorThrown = false;
      try {
        await badClient.connect(badTransport);
      } catch (_error) {
        errorThrown = true;
      }

      expect(errorThrown).toBe(true);

      await badTransport.close().catch(() => {});
      await badClient.close().catch(() => {});
    }, 10000);
  });

  describe("Tool Calling", () => {
    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    beforeAll(async () => {
      if (!commandExists("npx")) {
        return;
      }

      transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        stderr: "pipe",
      });

      client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

      await client.connect(transport);
    }, 30000);

    afterAll(async () => {
      if (transport) {
        await transport.close().catch(() => {});
      }
      if (client) {
        await client.close().catch(() => {});
      }
    });

    it("should list available tools from the server", async () => {
      if (!client) {
        console.log("Skipping test: client not initialized");
        return;
      }

      const response = await client.listTools();
      expect(response.tools).toBeDefined();
      expect(Array.isArray(response.tools)).toBe(true);
    });

    it("should call a tool with arguments", async () => {
      if (!client) {
        console.log("Skipping test: client not initialized");
        return;
      }

      const tools = await client.listTools();
      if (tools.tools.length === 0) {
        console.log("Skipping test: no tools available");
        return;
      }

      // Try to call the store_memory tool if available
      const storeTool = tools.tools.find((t) => t.name === "store_memory");
      if (storeTool) {
        const result = await client.callTool({
          name: "store_memory",
          arguments: {
            key: "test-key",
            value: "test-value",
          },
        });
        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
      }
    });
  });
});
