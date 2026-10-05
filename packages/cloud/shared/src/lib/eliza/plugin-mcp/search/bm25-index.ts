// Wires hosted Eliza agent bm25 index behavior for cloud runtime services.
import { BM25 } from "@elizaos/core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface Tier2ToolEntry {
  serverName: string;
  toolName: string;
  actionName: string;
  platform: string;
  tool: Tool;
}

/**
 * BM25-based search index for Tier-2 (discoverable) MCP tools.
 * Used by SEARCH_ACTIONS to find relevant tools that aren't in the always-visible set.
 */
export class Tier2ToolIndex {
  private bm25: BM25 | null = null;
  private tools: Tier2ToolEntry[] = [];

  /**
   * Builds the BM25 index from an array of Tier-2 tool entries.
   * Call this whenever the set of available tools changes (e.g., after MCP reconnect).
   */
  build(tier2Tools: Tier2ToolEntry[]): void {
    this.tools = tier2Tools;
    if (tier2Tools.length === 0) {
      this.bm25 = null;
      return;
    }
    const docs = tier2Tools.map((t) => ({
      name: t.actionName,
      description: t.tool.description || "",
      tags: this.buildTags(t),
    }));
    this.bm25 = new BM25(docs, {
      k1: 1.2,
      b: 0.75,
      fieldBoosts: { name: 3.0, description: 1.5, tags: 1.0 },
      stemming: false,
    });
  }

  /**
   * Searches the Tier-2 index for tools matching the query, sorted by BM25
   * relevance. The platform filter (e.g. "linear", "github") is applied to the
   * complete ranking before `offset`/`limit`, so a platform whose matches rank
   * below other platforms' hits still pages correctly. `total` is the number
   * of matches across all pages.
   */
  search(
    query: string,
    platform?: string,
    limit = 10,
    offset = 0,
  ): { entries: Tier2ToolEntry[]; total: number } {
    if (!this.bm25 || this.tools.length === 0) return { entries: [], total: 0 };

    let entries = this.bm25.search(query, this.tools.length).map((r) => this.tools[r.index]);
    if (platform) {
      const wanted = platform.toLowerCase();
      entries = entries.filter((e) => e.platform.toLowerCase() === wanted);
    }
    return { entries: entries.slice(offset, offset + limit), total: entries.length };
  }

  /**
   * Returns the total number of Tier-2 tools in the index.
   */
  getToolCount(): number {
    return this.tools.length;
  }

  /**
   * Builds a tag string for BM25 indexing from a tool entry.
   * Combines server name, platform, and tokenized tool name parts.
   */
  private buildTags(entry: Tier2ToolEntry): string {
    const parts = entry.toolName.replace(/[_-]/g, " ").split(/\s+/);
    return [entry.serverName, entry.platform, ...parts].join(" ");
  }
}
