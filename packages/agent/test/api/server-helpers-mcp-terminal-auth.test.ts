import { Socket } from "node:net";
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpServersIncludeStdio,
  resolveMcpTerminalAuthorizationRejection,
} from "../../src/api/server-helpers-mcp.ts";

function request(): http.IncomingMessage {
  return new http.IncomingMessage(new Socket());
}

describe("resolveMcpTerminalAuthorizationRejection", () => {
  const priorTerminal = process.env.ELIZA_TERMINAL_RUN_TOKEN;
  const priorCompat = process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP;
  const priorApi = process.env.ELIZA_API_TOKEN;

  afterEach(() => {
    if (priorTerminal === undefined) {
      delete process.env.ELIZA_TERMINAL_RUN_TOKEN;
    } else {
      process.env.ELIZA_TERMINAL_RUN_TOKEN = priorTerminal;
    }
    if (priorCompat === undefined) {
      delete process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP;
    } else {
      process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP = priorCompat;
    }
    if (priorApi === undefined) {
      delete process.env.ELIZA_API_TOKEN;
    } else {
      process.env.ELIZA_API_TOKEN = priorApi;
    }
  });

  it("detects stdio servers in a config map", () => {
    expect(
      mcpServersIncludeStdio({
        remote: { type: "http", url: "https://example.com/mcp" },
        local: { type: "stdio", command: "npx", args: ["pkg"] },
      }),
    ).toBe(true);
  });

  it("requires terminal token for stdio config by default", () => {
    delete process.env.ELIZA_TERMINAL_RUN_TOKEN;
    delete process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP;
    delete process.env.ELIZA_API_TOKEN;

    const rejection = resolveMcpTerminalAuthorizationRejection(
      request(),
      { evil: { type: "stdio", command: "npx", args: ["pkg"] } },
      {},
    );

    expect(rejection?.status).toBe(403);
    expect(rejection?.reason).toMatch(/ELIZA_TERMINAL_RUN_TOKEN/i);
  });

  it("allows legacy compat when ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP=1", () => {
    delete process.env.ELIZA_TERMINAL_RUN_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
    process.env.ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP = "1";

    expect(
      resolveMcpTerminalAuthorizationRejection(
        request(),
        { local: { type: "stdio", command: "npx", args: ["pkg"] } },
        {},
      ),
    ).toBeNull();
  });
});
