/** Hosted-runtime tests for operator-gated DoorDash MCP injection. */

import { afterEach, describe, expect, test } from "bun:test";
import type { UserContext } from "../user-context";
import { buildMcpSettings, getConnectedMcpPlatforms, shouldEnableMcp } from "./mcp-config";

const originalUrl = process.env.MCP_DOORDASH_STREAMABLE_HTTP_URL;

function context(): UserContext {
  return {
    userId: "user-1",
    entityId: "user-1",
    organizationId: "org-1",
    agentMode: "assistant",
    apiKey: "test-key",
    isAnonymous: false,
    oauthConnections: [],
  } as UserContext;
}

afterEach(() => {
  if (originalUrl === undefined) delete process.env.MCP_DOORDASH_STREAMABLE_HTTP_URL;
  else process.env.MCP_DOORDASH_STREAMABLE_HTTP_URL = originalUrl;
});

describe("DoorDash MCP cloud configuration", () => {
  test("stays disabled when no upstream is configured", () => {
    delete process.env.MCP_DOORDASH_STREAMABLE_HTTP_URL;
    expect(getConnectedMcpPlatforms(context())).not.toContain("doordash");
    expect(shouldEnableMcp(context())).toBe(false);
  });

  test("injects the internal cloud bridge when the operator configures an upstream", () => {
    process.env.MCP_DOORDASH_STREAMABLE_HTTP_URL = "https://adapter.example/mcp";
    expect(getConnectedMcpPlatforms(context())).toContain("doordash");
    expect(shouldEnableMcp(context())).toBe(true);
    expect(buildMcpSettings(context())).toEqual({
      mcp: {
        servers: {
          doordash: {
            url: "http://localhost:3000/api/mcps/doordash/streamable-http",
            type: "streamable-http",
            timeoutInMillis: 120_000,
          },
        },
      },
    });
  });
});
