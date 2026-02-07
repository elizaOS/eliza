import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { createScratchpadService } from "../services/scratchpadService";

/**
 * Provider that exposes scratchpad state to the agent's context.
 * This allows the agent to be aware of saved notes and memories.
 */
export const scratchpadProvider: Provider = {
  name: "scratchpad",
  description:
    "Provides information about the user's scratchpad entries - file-based notes and memories that persist across sessions.",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const service = createScratchpadService(runtime);
      const entries = await service.list();

      if (entries.length === 0) {
        return {
          text: "No scratchpad entries available.",
          data: { entries: [], count: 0 },
          values: { scratchpadCount: 0 },
        };
      }

      // Build summary text
      const summaryLines = [`**Scratchpad** (${entries.length} entries available):`, ""];

      // Show up to 5 most recent entries with previews
      const recentEntries = entries.slice(0, 5);
      for (const entry of recentEntries) {
        // Get content preview (strip frontmatter, limit length)
        const contentWithoutFrontmatter = entry.content.replace(/^---[\s\S]*?---\n*/m, "").trim();
        const preview = contentWithoutFrontmatter.substring(0, 80).replace(/\n/g, " ");

        const tagsStr = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";

        summaryLines.push(`- **${entry.title}** (${entry.id})${tagsStr}`);
        summaryLines.push(`  ${preview}${contentWithoutFrontmatter.length > 80 ? "..." : ""}`);
      }

      if (entries.length > 5) {
        summaryLines.push(`\n_...and ${entries.length - 5} more entries_`);
      }

      summaryLines.push(
        "\n_Use SCRATCHPAD_SEARCH to find specific entries or SCRATCHPAD_READ to view full content._"
      );

      // Build data payload
      const entryData = entries.map((e) => ({
        id: e.id,
        title: e.title,
        modifiedAt: e.modifiedAt.toISOString(),
        tags: e.tags ?? [],
      }));

      return {
        text: summaryLines.join("\n"),
        data: {
          entries: entryData,
          count: entries.length,
          basePath: service.getBasePath(),
        },
        values: {
          scratchpadCount: entries.length,
          scratchpadEntryIds: entries.map((e) => e.id).join(", "),
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadProvider] Error:", errorMsg);
      return {
        text: "Scratchpad service unavailable.",
        data: { error: errorMsg },
        values: { scratchpadCount: 0 },
      };
    }
  },
};

export default scratchpadProvider;
