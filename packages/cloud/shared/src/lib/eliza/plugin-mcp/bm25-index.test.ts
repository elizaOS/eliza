/** Exercises Tier-2 MCP tool discovery ranking, platform filtering and pagination on the real BM25 index (#29650). */
import { describe, expect, test } from "bun:test";
import { type Tier2ToolEntry, Tier2ToolIndex } from "./bm25-index";

function entry(platform: string, name: string, description: string): Tier2ToolEntry {
  return {
    serverName: `${platform}-server`,
    toolName: name,
    actionName: `${platform.toUpperCase()}_${name.toUpperCase()}`,
    platform,
    tool: { name, description, inputSchema: { type: "object" } },
  };
}

// Twenty strong GitHub matches outrank the weaker Linear matches, so any
// fixed over-fetch window taken before filtering would drop Linear entirely.
const tools: Tier2ToolEntry[] = [
  ...Array.from({ length: 20 }, (_, i) =>
    entry("github", `create_issue_${i}`, "create issue create issue in a repository"),
  ),
  ...Array.from({ length: 3 }, (_, i) =>
    entry("linear", `file_ticket_${i}`, "file a ticket; an issue tracker"),
  ),
];

describe("Tier2ToolIndex.search", () => {
  test("finds platform matches that rank below other platforms' hits", () => {
    const index = new Tier2ToolIndex();
    index.build(tools);
    const { entries, total } = index.search("create issue", "linear", 2, 0);
    expect(total).toBe(3);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.platform === "linear")).toBe(true);
  });

  test("pages a filtered ranking without gaps or repeats", () => {
    const index = new Tier2ToolIndex();
    index.build(tools);
    const first = index.search("issue", "LINEAR", 2, 0);
    const second = index.search("issue", "linear", 2, 2);
    const names = [...first.entries, ...second.entries].map((e) => e.toolName);
    expect(new Set(names).size).toBe(3);
    expect(second.entries).toHaveLength(1);
    expect(second.total).toBe(3);
    expect(index.search("issue", "linear", 2, 4).entries).toEqual([]);
  });

  test("reports the unfiltered total and an empty index", () => {
    const index = new Tier2ToolIndex();
    expect(index.search("issue")).toEqual({ entries: [], total: 0 });
    index.build(tools);
    const { entries, total } = index.search("issue", undefined, 5, 0);
    expect(total).toBe(23);
    expect(entries).toHaveLength(5);
  });
});
