/**
 * Reads workspace bootstrap files and injects them into agent context.
 */

import type { IAgentRuntime, Memory, State, Provider, ProviderResult } from "@elizaos/core";
import {
  loadWorkspaceBootstrapFiles,
  filterBootstrapFilesForSession,
  DEFAULT_AGENT_WORKSPACE_DIR,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const DEFAULT_MAX_CHARS = 20_000;
const CACHE_TTL_MS = 60_000;

// Per-workspace cache so multi-agent doesn't thrash.
const cache = new Map<string, { files: WorkspaceBootstrapFile[]; at: number }>();

async function getFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const entry = cache.get(dir);
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.files;

  const files = await loadWorkspaceBootstrapFiles(dir);
  cache.set(dir, { files, at: Date.now() });
  return files;
}

function truncate(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n[... truncated at ${max.toLocaleString()} chars]`;
}

function buildContext(files: WorkspaceBootstrapFile[], maxChars: number): string {
  const sections: string[] = [];
  for (const f of files) {
    if (f.missing || !f.content?.trim()) continue;
    const text = truncate(f.content.trim(), maxChars);
    const tag = text.length > f.content.trim().length ? " [TRUNCATED]" : "";
    sections.push(`### ${f.name}${tag}\n\n${text}`);
  }
  if (sections.length === 0) return "";
  return `## Project Context (Workspace)\n\n${sections.join("\n\n---\n\n")}`;
}

export function createWorkspaceProvider(options?: {
  workspaceDir?: string;
  maxCharsPerFile?: number;
}): Provider {
  const dir = options?.workspaceDir ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const maxChars = options?.maxCharsPerFile ?? DEFAULT_MAX_CHARS;

  return {
    name: "workspaceContext",
    description: "Workspace bootstrap files (AGENTS.md, TOOLS.md, IDENTITY.md, etc.)",
    position: 10,

    async get(_runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> {
      try {
        const allFiles = await getFiles(dir);
        const sessionKey = (message.metadata as Record<string, unknown> | undefined)?.sessionKey as string | undefined;
        const files = filterBootstrapFilesForSession(allFiles, sessionKey);
        const text = buildContext(files, maxChars);

        return { text, data: { workspaceDir: dir } };
      } catch (err) {
        return {
          text: `[Workspace context unavailable: ${err instanceof Error ? err.message : err}]`,
          data: {},
        };
      }
    },
  };
}

