/**
 * GET /api/mcp/info — the advertised tool inventory must equal the served one.
 *
 * The info document is a discovery surface for agent planners. It previously
 * listed 21 hand-maintained legacy tool names (generate_text, save_memory,
 * text_to_speech, ...) while the real platform MCP serves a dynamic `cloud.*`
 * capability inventory — zero overlap, so every advertised call failed with
 * "Unknown Cloud capability". Harness is REAL: it boots the actual Hono route
 * app (no service mocks needed — this endpoint touches no DB or env) and
 * compares the response against `listPlatformCloudMcpTools`, the exact source
 * the JSON-RPC `tools/list` handler serves.
 */

import { describe, expect, test } from "bun:test";
import { PLATFORM_MCP_TOOL_PRICING } from "@elizaos/cloud-shared/billing";

import { listPlatformCloudMcpTools } from "@/lib/mcp/platform-cloud-tools";

const infoRoute = (await import("../mcp/info/route")) as {
  default: { fetch: (req: Request) => Promise<Response> };
};

type InfoTool = { name: string; description: string; category: string };
type InfoBody = {
  name: string;
  version: string;
  transport: string[];
  endpoint: string;
  authRequired: boolean;
  tools: InfoTool[];
  toolCount: number;
  categories: string[];
  pricing: {
    type: string;
    description: string;
    creditUnit: string;
    rates: Record<string, string>;
  };
  authentication: { type: string; header: string; description: string };
  status: string;
};

async function getInfo(): Promise<InfoBody> {
  const res = await infoRoute.default.fetch(new Request("http://test.local/"));
  expect(res.status).toBe(200);
  return (await res.json()) as InfoBody;
}

describe("GET /api/mcp/info advertises exactly the served inventory", () => {
  test("every advertised tool exists on the real server, and vice versa", async () => {
    const body = await getInfo();
    const served = listPlatformCloudMcpTools().map((tool) => tool.name);

    expect(body.toolCount).toBe(served.length);
    expect(body.tools.map((tool) => tool.name).sort()).toEqual(
      [...served].sort(),
    );
  });

  test("advertised tools are executable names, not legacy phantom names", async () => {
    const body = await getInfo();
    for (const tool of body.tools) {
      // Phantom names from the old hand-maintained list; none of these resolve
      // through findCapability() and every such tools/call fails.
      expect(tool.name.startsWith("cloud.")).toBe(true);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("toolCount matches the listed tools and categories are non-empty", async () => {
    const body = await getInfo();
    expect(body.tools.length).toBe(body.toolCount);
    expect(body.toolCount).toBeGreaterThan(0);
    expect(body.categories.length).toBeGreaterThan(0);
    for (const category of body.categories) {
      expect(body.tools.some((tool) => tool.category === category)).toBe(true);
    }
  });

  test("stable discovery fields are preserved", async () => {
    const body = await getInfo();
    expect(body.name).toBe("Eliza Cloud MCP");
    expect(body.endpoint).toBe("/api/mcp");
    expect(body.transport).toEqual(["streamable-http"]);
    expect(body.authRequired).toBe(true);
    expect(body.status).toBe("live");
    expect(body.pricing.creditUnit).toBe("USD");
    expect(body.pricing.rates.save_memory).toBe(
      PLATFORM_MCP_TOOL_PRICING.save_memory.label,
    );
    expect(body.pricing.rates.retrieve_memories).toBe(
      PLATFORM_MCP_TOOL_PRICING.retrieve_memories.label,
    );
    expect(body.authentication.type).toBe("Bearer");
    expect(body.authentication.header).toBe("Authorization");
  });
});

describe("categoryForToolName", () => {
  test("derives the domain segment", async () => {
    const { categoryForToolName } = await import("../mcp/info/route");
    expect(categoryForToolName("cloud.credits.summary")).toBe("credits");
    expect(categoryForToolName("cloud.agents.chat")).toBe("agents");
  });

  test("falls back to platform for malformed names", async () => {
    const { categoryForToolName } = await import("../mcp/info/route");
    expect(categoryForToolName("noDots")).toBe("platform");
    expect(categoryForToolName("cloud.")).toBe("platform");
  });
});
