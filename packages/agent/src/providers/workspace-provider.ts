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
import type { CodingAgentContext } from "@elizaos/plugin-coding-tools";
import { hasAdminAccess } from "../security/access.js";
import {
  filterInitFilesForSession,
  isDefaultBoilerplate,
  loadWorkspaceInitFiles,
  resolveDefaultAgentWorkspaceDir,
  type WorkspaceInitFile,
} from "./workspace.js";

const DEFAULT_MAX_CHARS = 20_000;
/** Hard cap on total workspace context to prevent prompt explosion. */
const MAX_TOTAL_WORKSPACE_CHARS = 100_000;
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
export function truncate(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n[... truncated at ${max.toLocaleString()} chars]`;
}

/** @internal Exported for testing. */
export function buildContext(
  files: WorkspaceInitFile[],
  maxChars: number,
): string {
  const sections: string[] = [];
  let totalChars = 0;
  for (const f of files) {
    if (f.missing || !f.content?.trim()) continue;
    // Skip files that are still the default boilerplate — they add ~3k of
    // generic placeholder text with zero useful context for the model.
    if (isDefaultBoilerplate(f.name, f.content)) continue;
    const trimmed = f.content.trim();
    // Per-file truncation
    const text = truncate(trimmed, maxChars);
    const tag = text.length > trimmed.length ? " [TRUNCATED]" : "";
    const section = `### ${f.name}${tag}\n\n${text}`;
    // Stop adding files if the total would exceed the hard cap
    if (
      totalChars + section.length > MAX_TOTAL_WORKSPACE_CHARS &&
      sections.length > 0
    ) {
      break;
    }
    sections.push(section);
    totalChars += section.length;
  }
  if (sections.length === 0) return "";
  return `## Project Context (Workspace)\n\n${sections.join("\n\n---\n\n")}`;
}

/** @internal Exported for testing. Builds a summary of the task-agent session. */
export function buildCodingAgentSummary(ctx: CodingAgentContext): string {
  const lines: string[] = [];

  lines.push("## Task Agent Session");
  lines.push("");
  lines.push(`**Task:** ${ctx.taskDescription}`);
  lines.push(`**Working Directory:** ${ctx.workingDirectory}`);
  lines.push(`**Connector:** ${ctx.connector.type}`);
  lines.push(`**Mode:** ${ctx.interactionMode}`);
  lines.push(`**Active:** ${ctx.active ? "yes" : "no"}`);

  if (!ctx.connector.available) {
    lines.push(`**Connector Status:** unavailable`);
  }

  // Errors from the last iteration
  const lastIteration = ctx.iterations[ctx.iterations.length - 1];
  if (lastIteration && lastIteration.errors.length > 0) {
    lines.push("");
    lines.push("### Errors to Resolve");
    for (const err of lastIteration.errors) {
      const loc = err.filePath
        ? err.line
          ? ` (${err.filePath}:${err.line})`
          : ` (${err.filePath})`
        : "";
      lines.push(`- [${err.category}]${loc}: ${err.message}`);
    }
  }

  // Human feedback
  const pendingFeedback = ctx.allFeedback.filter(
    (fb) =>
      fb.iterationRef !== undefined &&
      fb.iterationRef >= ctx.iterations.length - 1,
  );
  if (pendingFeedback.length > 0) {
    lines.push("");
    lines.push("### Human Feedback");
    for (const fb of pendingFeedback) {
      lines.push(`- [${fb.type}]: ${fb.text}`);
    }
  }

  // Recent commands from the last iteration
  if (lastIteration && lastIteration.commandResults.length > 0) {
    lines.push("");
    lines.push("### Recent Commands");
    for (const cmd of lastIteration.commandResults.slice(-5)) {
      const status = cmd.success ? "OK" : `FAIL(${cmd.exitCode})`;
      lines.push(`- \`${cmd.command}\` → ${status}`);
      if (cmd.stdout?.trim()) {
        lines.push(`  stdout: ${truncate(cmd.stdout.trim(), 200)}`);
      }
      if (cmd.stderr?.trim()) {
        lines.push(`  stderr: ${truncate(cmd.stderr.trim(), 200)}`);
      }
    }
  }

  return lines.join("\n");
}

export function createWorkspaceProvider(options?: {
  workspaceDir?: string;
  maxCharsPerFile?: number;
}): Provider {
  const dir = options?.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const maxChars = options?.maxCharsPerFile ?? DEFAULT_MAX_CHARS;

  return {
    name: "workspaceContext",
    description:
      "Workspace init files (AGENTS.md, TOOLS.md, IDENTITY.md, etc.) and task-agent context",
    position: 10,
    contexts: ["general"],
    contextGate: { anyOf: ["general"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const channelType = message.content?.channelType;
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

      if (!(await hasAdminAccess(_runtime, message))) {
        return {
          text: "",
          data: {
            workspaceDir: dir,
            skipped: "role_gate",
          },
        };
      }

      try {
        const allFiles = await getFiles(dir);
        const meta = message.metadata as Record<string, unknown> | undefined;
        const sessionKey =
          typeof meta?.sessionKey === "string" ? meta.sessionKey : undefined;
        const files = filterInitFilesForSession(allFiles, sessionKey);
        const text = buildContext(files, maxChars);

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
