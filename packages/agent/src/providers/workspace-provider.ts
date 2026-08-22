/**
 * Reads workspace init files and injects them into agent context.
 *
 * Also provides task-agent context enrichment: when task-agent metadata
 * is present on the inbound message, the provider appends a summary of the
 * current task-agent session state (active iteration, recent errors, pending
 * feedback) so the LLM has full awareness during autonomous background work.
 */

import {
  ChannelType,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import {
  filterInitFilesForSession,
  isDefaultBoilerplate,
  loadWorkspaceInitFiles,
  resolveDefaultAgentWorkspaceDir,
  type WorkspaceInitFile,
} from "./workspace.ts";

const CACHE_TTL_MS = 60_000;

// Per-workspace cache so multi-agent doesn't thrash.
const cache = new Map<string, { files: WorkspaceInitFile[]; at: number }>();
/** Maximum number of workspace directories to cache simultaneously. */
const MAX_CACHE_ENTRIES = 20;

async function getFiles(dir: string): Promise<WorkspaceInitFile[]> {
  const now = Date.now();
  const entry = cache.get(dir);
  if (entry && now - entry.at < CACHE_TTL_MS) return entry.files;

  // Evict expired entries and enforce size cap before inserting
  for (const [key, val] of cache) {
    if (now - val.at >= CACHE_TTL_MS) cache.delete(key);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Remove the oldest entry
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  const files = await loadWorkspaceInitFiles(dir);
  cache.set(dir, { files, at: now });
  return files;
}

/** @internal Exported for testing. */
export function buildContext(files: WorkspaceInitFile[]): string {
  const sections: string[] = [];
  for (const f of files) {
    if (f.missing || !f.content?.trim()) continue;
    // Skip files that are still the default boilerplate — they add ~3k of
    // generic template text with zero useful context for the model.
    if (isDefaultBoilerplate(f.name, f.content)) continue;
    const trimmed = f.content.trim();
    sections.push(`### ${f.name}\n\n${trimmed}`);
  }
  if (sections.length === 0) return "";
  return `## Project Context (Workspace)\n\n${sections.join("\n\n---\n\n")}`;
}

export function createWorkspaceProvider(options?: {
  workspaceDir?: string;
}): Provider {
  const dir = options?.workspaceDir ?? resolveDefaultAgentWorkspaceDir();

  return {
    name: "workspaceContext",
    description:
      "Workspace init files (AGENTS.md, TOOLS.md, IDENTITY.md, etc.) and task-agent context",
    position: 10,
    // Workspace instructions govern code and autonomous workspace work. Keeping
    // them out of ordinary `general` tool turns prevents an unrelated repo guide
    // from dominating small app/device actions such as opening a view.
    contexts: ["code", "files", "terminal", "automation"],
    contextGate: { anyOf: ["code", "files", "terminal", "automation"] },
    cacheStable: false,
    cacheScope: "turn",
    // #12087 Item 14: was USER but the body enforced ADMIN (hasAdminAccess).
    // Declared roleGate is now enforced by applyPluginRoleGating.
    roleGate: { minRole: "ADMIN" },

    async get(
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const channelType = message.content.channelType;
      if (
        channelType === ChannelType.VOICE_DM ||
        channelType === ChannelType.VOICE_GROUP
      ) {
        return {
          text: "",
          data: {
            workspaceDir: dir,
            skipped: "voice_channel",
          },
        };
      }

      try {
        const allFiles = await getFiles(dir);
        const meta = message.metadata as Record<string, unknown> | undefined;
        const sessionKey =
          typeof meta?.sessionKey === "string" ? meta.sessionKey : undefined;
        const files = filterInitFilesForSession(allFiles, sessionKey);
        const text = buildContext(files);

        return {
          text,
          data: {
            workspaceDir: dir,
          },
        };
      } catch (err) {
        logger.warn(
          `[workspace-provider] Failed to load workspace context: ${String(err)}`,
        );
        return {
          text: `[Workspace context unavailable: ${String(err)}]`,
          data: {},
        };
      }
    },
  };
}
