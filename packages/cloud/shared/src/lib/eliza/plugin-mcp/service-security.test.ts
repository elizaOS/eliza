/**
 * Validates the Cloud MCP client's trusted-origin and external-resource
 * boundary without opening a transport. Private destinations and serialized
 * bearer material must fail before DNS or connection setup.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { validateCloudMcpHttpConfig } from "./service";

const previousAppUrl = process.env.APP_URL;
const previousPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
  if (previousPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = previousPublicAppUrl;
});

describe("Cloud MCP remote config security", () => {
  test("allows the generated same-origin broker route", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    await expect(
      validateCloudMcpHttpConfig("google-gmail-binding", {
        type: "streamable-http",
        url: "http://localhost:3000/api/v1/eliza/agents/agent/connectors/binding/mcp/gmail",
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects private external destinations and serialized authorization", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://cloud.eliza.test";
    await expect(
      validateCloudMcpHttpConfig("metadata", {
        type: "streamable-http",
        url: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toThrow("Unsafe MCP server metadata");
    await expect(
      validateCloudMcpHttpConfig("raw-token", {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer raw-token" },
      }),
    ).rejects.toThrow("may not receive serialized credentials");
  });
});
