import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  ScratchpadConfig,
  ScratchpadEntry,
  ScratchpadReadOptions,
  ScratchpadSearchOptions,
  ScratchpadSearchResult,
  ScratchpadWriteOptions,
} from "../types";

const DEFAULT_CONFIG: ScratchpadConfig = {
  basePath: path.join(os.homedir(), ".eliza", "scratchpad"),
  maxFileSize: 1024 * 1024, // 1MB
  allowedExtensions: [".md", ".txt"],
};

/**
 * Service for managing file-based scratchpad memories.
 * Provides write, read, search, list, and delete operations.
 */
export class ScratchpadService {
  private config: ScratchpadConfig;

  constructor(_runtime: IAgentRuntime, config?: Partial<ScratchpadConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Ensures the scratchpad directory exists
   */
  private async ensureDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.config.basePath, { recursive: true });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadService] Failed to create directory:", errorMsg);
      throw error;
    }
  }

  /**
   * Generates a safe filename from a title
   */
  private sanitizeFilename(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 100);
  }

  /**
   * Gets the full path for a scratchpad entry
   */
  private getFilePath(id: string): string {
    const filename = id.endsWith(".md") ? id : `${id}.md`;
    return path.join(this.config.basePath, filename);
  }

  /**
   * Extracts entry ID from a filename
   */
  private getEntryId(filename: string): string {
    return path.basename(filename, path.extname(filename));
  }

  /**
   * Writes or appends content to a scratchpad entry
   */
  async write(
    title: string,
    content: string,
    options: ScratchpadWriteOptions = {}
  ): Promise<ScratchpadEntry> {
    await this.ensureDirectory();

    const id = this.sanitizeFilename(title);
    const filePath = this.getFilePath(id);
    const now = new Date();

    let finalContent: string;
    let createdAt = now;

    const exists = await this.exists(id);
    if (exists && options.append) {
      const existing = await this.read(id);
      finalContent = `${existing.content}\n\n---\n\n${content}`;
      createdAt = existing.createdAt;
    } else {
      // Create frontmatter with metadata
      const tagsLine = options.tags?.length ? `tags: [${options.tags.join(", ")}]` : "";
      const frontmatter = [
        "---",
        `title: "${title}"`,
        `created: ${now.toISOString()}`,
        `modified: ${now.toISOString()}`,
        tagsLine,
        "---",
        "",
      ]
        .filter(Boolean)
        .join("\n");

      finalContent = `${frontmatter}\n${content}`;
    }

    // Check file size
    if (Buffer.byteLength(finalContent, "utf8") > (this.config.maxFileSize ?? 1024 * 1024)) {
      throw new Error(`Content exceeds maximum file size of ${this.config.maxFileSize} bytes`);
    }

    await fs.writeFile(filePath, finalContent, "utf8");

    logger.info(`[ScratchpadService] Wrote entry: ${id}`);

    return {
      id,
      path: filePath,
      title,
      content: finalContent,
      createdAt,
      modifiedAt: now,
      tags: options.tags,
    };
  }

  /**
   * Reads a scratchpad entry by ID
   */
  async read(id: string, options: ScratchpadReadOptions = {}): Promise<ScratchpadEntry> {
    const filePath = this.getFilePath(id);

    try {
      const stat = await fs.stat(filePath);
      let content = await fs.readFile(filePath, "utf8");

      // Handle line range reading
      if (options.from !== undefined || options.lines !== undefined) {
        const lines = content.split("\n");
        const fromLine = Math.max(1, options.from ?? 1) - 1; // Convert to 0-indexed
        const numLines = options.lines ?? lines.length - fromLine;
        content = lines.slice(fromLine, fromLine + numLines).join("\n");
      }

      // Parse frontmatter for metadata
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let title = id;
      let tags: string[] = [];
      let createdAt = stat.birthtime;

      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const titleMatch = frontmatter.match(/title:\s*"?([^"\n]+)"?/);
        const tagsMatch = frontmatter.match(/tags:\s*\[([^\]]+)\]/);
        const createdMatch = frontmatter.match(/created:\s*(.+)/);

        if (titleMatch) title = titleMatch[1];
        if (tagsMatch) tags = tagsMatch[1].split(",").map((t) => t.trim());
        if (createdMatch) createdAt = new Date(createdMatch[1]);
      }

      return {
        id,
        path: filePath,
        title,
        content,
        createdAt,
        modifiedAt: stat.mtime,
        tags,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Scratchpad entry not found: ${id}`);
      }
      throw error;
    }
  }

  /**
   * Checks if a scratchpad entry exists
   */
  async exists(id: string): Promise<boolean> {
    const filePath = this.getFilePath(id);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lists all scratchpad entries
   */
  async list(): Promise<ScratchpadEntry[]> {
    await this.ensureDirectory();

    try {
      const files = await fs.readdir(this.config.basePath);
      const entries: ScratchpadEntry[] = [];

      for (const file of files) {
        const ext = path.extname(file);
        if (!this.config.allowedExtensions?.includes(ext)) continue;

        try {
          const id = this.getEntryId(file);
          const entry = await this.read(id);
          entries.push(entry);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`[ScratchpadService] Failed to read entry ${file}:`, errorMsg);
        }
      }

      // Sort by modified date, most recent first
      return entries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadService] Failed to list entries:", errorMsg);
      return [];
    }
  }

  /**
   * Searches scratchpad entries using text matching
   */
  async search(
    query: string,
    options: ScratchpadSearchOptions = {}
  ): Promise<ScratchpadSearchResult[]> {
    const entries = await this.list();
    const results: ScratchpadSearchResult[] = [];

    const maxResults = options.maxResults ?? 10;
    const minScore = options.minScore ?? 0.1;

    // Tokenize and lowercase the query
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    for (const entry of entries) {
      const lines = entry.content.split("\n");
      const contentLower = entry.content.toLowerCase();

      // Calculate relevance score based on term frequency
      let matchCount = 0;
      for (const term of queryTerms) {
        const regex = new RegExp(term, "gi");
        const matches = contentLower.match(regex);
        if (matches) matchCount += matches.length;
      }

      if (matchCount === 0) continue;

      // Calculate score (simple TF-based scoring)
      const score = Math.min(1, matchCount / (queryTerms.length * 3));
      if (score < minScore) continue;

      // Find the best matching snippet
      let bestSnippetStart = 0;
      let bestSnippetEnd = Math.min(lines.length, 5);

      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        for (const term of queryTerms) {
          if (lineLower.includes(term)) {
            bestSnippetStart = Math.max(0, i - 2);
            bestSnippetEnd = Math.min(lines.length, i + 3);
            break;
          }
        }
      }

      const snippet = lines.slice(bestSnippetStart, bestSnippetEnd).join("\n");

      results.push({
        path: entry.path,
        startLine: bestSnippetStart + 1,
        endLine: bestSnippetEnd,
        score,
        snippet,
        entryId: entry.id,
      });
    }

    // Sort by score descending and limit results
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /**
   * Deletes a scratchpad entry
   */
  async delete(id: string): Promise<boolean> {
    const filePath = this.getFilePath(id);

    try {
      await fs.unlink(filePath);
      logger.info(`[ScratchpadService] Deleted entry: ${id}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  /**
   * Gets a summary of all scratchpad content
   */
  async getSummary(): Promise<string> {
    const entries = await this.list();

    if (entries.length === 0) {
      return "No scratchpad entries found.";
    }

    const summaryParts = [`**Scratchpad Summary** (${entries.length} entries)`, ""];

    for (const entry of entries.slice(0, 10)) {
      const preview = entry.content
        .replace(/^---[\s\S]*?---\n*/m, "") // Remove frontmatter
        .substring(0, 100)
        .replace(/\n/g, " ")
        .trim();

      summaryParts.push(`- **${entry.title}** (${entry.id})`);
      summaryParts.push(`  ${preview}${preview.length >= 100 ? "..." : ""}`);
      summaryParts.push(`  _Modified: ${entry.modifiedAt.toLocaleDateString()}_`);
    }

    if (entries.length > 10) {
      summaryParts.push(`\n_...and ${entries.length - 10} more entries_`);
    }

    return summaryParts.join("\n");
  }

  /**
   * Gets the base path for scratchpad files
   */
  getBasePath(): string {
    return this.config.basePath;
  }
}

/**
 * Factory function to create a ScratchpadService instance
 */
export function createScratchpadService(
  runtime: IAgentRuntime,
  config?: Partial<ScratchpadConfig>
): ScratchpadService {
  return new ScratchpadService(runtime, config);
}
