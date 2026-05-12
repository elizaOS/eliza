import { describe, expect, test } from "bun:test";
import { getCrucialToolsForServer, isCrucialTool } from "@/lib/eliza/plugin-mcp/tool-visibility";

describe("MCP tool visibility", () => {
  test("keeps core Twitter tools visible and promotes mentions", () => {
    const twitterTools = getCrucialToolsForServer("twitter");

    expect(twitterTools).toContain("twitter_get_me");
    expect(twitterTools).toContain("twitter_get_mentions");
    expect(isCrucialTool("twitter", "twitter_get_me")).toBe(true);
    expect(isCrucialTool("twitter", "twitter_get_mentions")).toBe(true);
  });
});
