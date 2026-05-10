import { describe, expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { checkMcpOAuthAccess } from "@/lib/eliza/plugin-mcp/utils/mcp";
import oauthPlugin, { oauthPlugin as namedOauthPlugin } from "@/lib/eliza/plugin-oauth";

function runtimeWithSetting(value: unknown): IAgentRuntime {
  return {
    getSetting: (key: string) => (key === "MCP_ENABLED_SERVERS" ? value : undefined),
  } as IAgentRuntime;
}

describe("plugin consolidation", () => {
  test("exports the local OAuth plugin object", () => {
    expect(oauthPlugin).toBe(namedOauthPlugin);
    expect(oauthPlugin.name).toBe("eliza-cloud-oauth");
    expect(oauthPlugin.actions?.map((action) => action.name).sort()).toEqual(["OAUTH"]);
    expect(oauthPlugin.providers?.map((provider) => provider.name)).toContain("USER_AUTH_STATUS");
  });

  test("keeps MCP access scoped to enabled servers when request context is present", () => {
    const runtime = runtimeWithSetting(JSON.stringify(["google"]));

    expect(checkMcpOAuthAccess(runtime, "google")).toBe(true);
    expect(checkMcpOAuthAccess(runtime, "slack")).toBe(false);
    expect(checkMcpOAuthAccess(runtime)).toBe(true);
  });

  test("denies malformed MCP access context instead of failing open", () => {
    expect(checkMcpOAuthAccess(runtimeWithSetting("{not json}"), "google")).toBe(false);
    expect(
      checkMcpOAuthAccess(runtimeWithSetting(JSON.stringify({ google: true })), "google"),
    ).toBe(false);
  });

  test("fails open only when no cloud request context setting exists", () => {
    expect(checkMcpOAuthAccess(runtimeWithSetting(undefined), "google")).toBe(true);
  });
});
