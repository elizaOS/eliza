import { describe, expect, it } from "bun:test";
import { getAvailableTools } from "../../../mcp/src/server/mcp-server";
import {
  validateCreatePostArgs,
  validateGetLeaderboardArgs,
  validateGetPortfolioArgs,
  validateGetPostArgs,
  validateResolveMarketArgs,
  validateSearchAgentsArgs,
} from "../../../mcp/src/utils/tool-args-validation";

describe("MCP Parity Surface", () => {
  it("exposes the parity tools expected by QA clients", () => {
    const toolNames = new Set(getAvailableTools().map((tool) => tool.name));

    expect(toolNames.has("get_post")).toBe(true);
    expect(toolNames.has("search_agents")).toBe(true);
    expect(toolNames.has("get_portfolio")).toBe(true);
    expect(toolNames.has("resolve_market")).toBe(true);
  });

  it("accepts mediaUrl on create_post arguments", () => {
    const args = validateCreatePostArgs({
      content: "Post with media",
      mediaUrl: "https://example.com/image.png",
    });

    expect(args.mediaUrl).toBe("https://example.com/image.png");
    expect(args.type).toBe("post");
  });

  it("accepts wallet/team leaderboard type arguments", () => {
    expect(validateGetLeaderboardArgs({ type: "wallet" }).type).toBe("wallet");
    expect(validateGetLeaderboardArgs({ type: "team" }).type).toBe("team");
  });

  it("validates new parity tool arguments", () => {
    expect(validateGetPostArgs({ postId: "post-123" }).postId).toBe("post-123");
    expect(validateSearchAgentsArgs({ query: "alpha", limit: 5 }).limit).toBe(
      5,
    );
    expect(validateGetPortfolioArgs({})).toEqual({});
    expect(
      validateResolveMarketArgs({ marketId: "market-123", resolution: true })
        .resolution,
    ).toBe(true);
  });
});
