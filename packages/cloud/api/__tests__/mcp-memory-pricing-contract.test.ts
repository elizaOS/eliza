/** Verifies that both public MCP discovery routes advertise executing memory prices. */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import infoRoute from "../mcp/info/route";
import listRoute from "../mcp/list/route";

describe("MCP memory pricing contract", () => {
  test("info and list agree that saves cost $1 and retrieval is free", async () => {
    const infoApp = new Hono().route("/", infoRoute);
    const listApp = new Hono().route("/", listRoute);

    const [infoResponse, listResponse] = await Promise.all([
      infoApp.request("/"),
      listApp.request("/"),
    ]);
    const info = (await infoResponse.json()) as {
      pricing: { rates: Record<string, string> };
    };
    const list = (await listResponse.json()) as {
      mcps: Array<{
        id: string;
        tools: Array<{ name: string; cost: string; description: string }>;
      }>;
    };
    const platform = list.mcps.find((entry) => entry.id === "eliza-cloud-mcp");
    const save = platform?.tools.find((tool) => tool.name === "save_memory");
    const retrieve = platform?.tools.find(
      (tool) => tool.name === "retrieve_memories",
    );

    expect(info.pricing.rates.save_memory).toBe("$1 in cloud credit");
    expect(info.pricing.rates.retrieve_memories).toBe("Free");
    expect(save?.cost).toBe("$1 in cloud credit");
    expect(retrieve?.cost).toBe("Free");
    expect(retrieve?.description.toLowerCase()).toContain("free");
  });
});
