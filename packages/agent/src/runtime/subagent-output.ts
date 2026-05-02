/**
 * Subagent output helpers for delivering final task output to the originating
 * chat channel.
 *
 * The swarm synthesis path uses `completionSummary` (a short LLM-generated
 * description of what the agent did). For user-facing replies we want the
 * subagent's actual answer — the last `stop_reason: end_turn` assistant
 * message from the Claude Code session jsonl. This module reads that and
 * provides Discord-safe chunking.
 *
 * Path encoding mirrors Claude Code: `/home/eliza/.eliza/workspaces/abc`
 * becomes `-home-eliza--eliza-workspaces-abc` (every `/` and `.` maps to
 * `-`; the sequence `/.` produces `--`).
 *
 * @module runtime/subagent-output
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Subset of the Claude Code jsonl line shape we care about. Shared by the
 *  end-turn reader and the activity scanner so both agree on what a parsed
 *  assistant line looks like. */
interface JsonlAssistantLine {
  subtype?: string;
  isApiErrorMessage?: boolean;
  message?: {
    role?: string;
    model?: string;
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string; name?: string }>;
  };
}

function parseJsonlLine(line: string): JsonlAssistantLine | null {
  try {
    return JSON.parse(line) as JsonlAssistantLine;
  } catch {
    return null;
  }
}

/**
 * Read the latest `stop_reason: end_turn` assistant text from the Claude Code
 * session jsonl under a subagent's workdir. Returns null when no such line
 * exists yet (still running, crashed before responding, or wrong workdir).
 */
export async function readLastAssistantTextFromJsonl(
  workdir: string,
): Promise<string | null> {
  const content = await readJsonl(workdir);
  return content === null ? null : findLatestEndTurnText(content);
}

/**
 * Locate the newest `.jsonl` file under Claude Code's project directory for
 * the given workdir.
 */
export async function findLatestJsonl(workdir: string): Promise<string | null> {
  const projectKey = workdir.replace(/[/.]/g, "-");
  const projectDir = join(homedir(), ".claude", "projects", projectKey);
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return null;
  }
  const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonls.length === 0) return null;
  const withMtime = await Promise.all(
    jsonls.map(async (f) => {
      const s = await fs.stat(join(projectDir, f));
      return { f, mtime: s.mtimeMs };
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return join(projectDir, withMtime[0].f);
}

async function readJsonl(workdir: string): Promise<string | null> {
  const jsonlPath = await findLatestJsonl(workdir);
  if (!jsonlPath) return null;
  try {
    return await fs.readFile(jsonlPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Scan jsonl text tail-first for the latest assistant message with
 * `stop_reason: end_turn` and return its text. Walks past any trailing
 * `tool_use` turns (the coordinator's "respond" follow-up can trigger
 * another tool round after the real answer, leaving a tool_use line
 * as the tail). Skips synthetic retry shims and Anthropic api_error
 * frames (529/overload) so transient retries never surface as the
 * agent's answer.
 */
export function findLatestEndTurnText(content: string): string | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = parseJsonlLine(line);
    if (!parsed) continue;
    if (parsed.subtype === "api_error" || parsed.isApiErrorMessage) continue;
    const msg = parsed.message;
    if (!msg || msg.role !== "assistant") continue;
    if (msg.model === "<synthetic>") continue;
    if (msg.stop_reason !== "end_turn") continue;
    const textParts: string[] = [];
    for (const c of msg.content ?? []) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        textParts.push(c.text.trim());
      }
    }
    if (textParts.length > 0) return textParts.join("\n\n");
  }
  return null;
}

/**
 * Scan jsonl tail-first for the most recent subagent activity worth showing
 * the user in a heartbeat — the name of the most recent `tool_use` call,
 * falling back to the leading text of the latest assistant block. Returns
 * null if the jsonl has no assistant/tool activity yet.
 */
export async function readCurrentActivityFromJsonl(
  workdir: string,
): Promise<string | null> {
  const content = await readJsonl(workdir);
  if (content === null) return null;
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = parseJsonlLine(line);
    if (!parsed) continue;
    if (parsed.subtype === "api_error" || parsed.isApiErrorMessage) continue;
    const msg = parsed.message;
    if (!msg || msg.role !== "assistant") continue;
    if (msg.model === "<synthetic>") continue;
    for (const c of msg.content ?? []) {
      if (c.type === "tool_use" && typeof c.name === "string") return c.name;
    }
    for (const c of msg.content ?? []) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        const first = c.text.trim().split("\n")[0] ?? "";
        return first.length > 80 ? `${first.slice(0, 77)}…` : first;
      }
    }
  }
  return null;
}

/**
 * Split text into Discord-safe chunks (≤ max chars each), preferring
 * paragraph → line → word boundaries past the halfway mark. Callers should
 * pass 1900 to leave headroom under Discord's 2000-char per-message limit.
 */
export function chunkForDiscord(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const half = Math.floor(max / 2);
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < half) cut = remaining.lastIndexOf("\n", max);
    if (cut < half) cut = remaining.lastIndexOf(" ", max);
    if (cut < half) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}
