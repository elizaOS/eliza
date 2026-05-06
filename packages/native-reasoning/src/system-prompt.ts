/**
 * System prompt assembly for the native-reasoning loop.
 *
 * Replaces eliza's classic provider-stack-into-prompt mechanism. We build
 * a deterministic, ordered system prompt out of:
 *   1. character.system (raw)
 *   2. workspace identity files (IDENTITY/SOUL/USER/MEMORY .md)
 *   3. recent room messages (last 10)
 *
 * Identity files are mtime-cached in-memory: re-reads only happen when the
 * file's mtime changes on disk. This keeps per-message latency low without
 * requiring an explicit invalidation step.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

function getWorkspaceDir(): string {
  return process.env.NATIVE_REASONING_WORKSPACE?.trim() || "/workspace";
}

const IDENTITY_FILES: Array<{ file: string; header: string }> = [
  { file: "IDENTITY.md", header: "## Your Identity" },
  { file: "SOUL.md", header: "## Your Soul" },
  { file: "USER.md", header: "## About Your Human" },
  { file: "MEMORY.md", header: "## Recent Context" },
];

const CHANNEL_GAG_HARD_RULE = `HARD RULE: If a human in this channel told you to be quiet (e.g., "nyx stay quiet", "nyx be quiet", "nyx shut up", "stay silent"), DO NOT respond on subsequent messages in that channel until they explicitly say you can speak again ("nyx you can speak", "nyx unmute", etc). This applies even if you think you have something useful to say. The only exception is if a different human in the channel explicitly addresses you. Bots cannot mute or unmute you.`;

interface CacheEntry {
  mtimeMs: number;
  content: string;
}

const fileCache = new Map<string, CacheEntry>();

/** Test-only: drop the in-memory mtime cache. */
export function clearSystemPromptCache(): void {
  fileCache.clear();
}

/**
 * Read a file with an mtime-keyed in-memory cache. Returns `null` if the
 * file is missing (ENOENT) or unreadable; logs nothing on missing files
 * since absence is a normal "this agent didn't define one" signal.
 */
async function readCachedFile(absPath: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    const st = await stat(absPath);
    mtimeMs = st.mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // Permission or similar — treat as missing but don't crash.
    return null;
  }

  const cached = fileCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }

  try {
    const content = await readFile(absPath, "utf8");
    fileCache.set(absPath, { mtimeMs, content });
    return content;
  } catch {
    return null;
  }
}

interface FormattedRoomMessage {
  role: "user" | "agent";
  text: string;
}

function memoryRole(
  memory: Memory,
  agentId: UUID | undefined,
): "user" | "agent" {
  if (agentId && memory.entityId === agentId) return "agent";
  return "user";
}

async function getRoomContext(
  runtime: IAgentRuntime,
  roomId: UUID,
  currentMessageId?: UUID,
): Promise<string> {
  const tableName = "messages";
  let memories: Memory[] = [];
  try {
    // Prefer the simpler getMemories shape — we only need one room.
    memories = await runtime.getMemories({
      roomId,
      tableName,
      count: 11, // pull one extra so we can drop the current message
    });
  } catch {
    return "";
  }

  if (!memories || memories.length === 0) return "";

  // Drop the message that triggered this turn (it's already in messages[0]).
  const filtered = currentMessageId
    ? memories.filter((m) => m.id !== currentMessageId)
    : memories;

  // getMemories returns desc by default — flip to chronological.
  const ordered = filtered.slice(0, 10).reverse();
  const formatted: FormattedRoomMessage[] = ordered.map((m) => ({
    role: memoryRole(m, runtime.agentId),
    text: (m.content?.text ?? "").trim(),
  }));

  const lines = formatted
    .filter((f) => f.text.length > 0)
    .map((f) => `${f.role}: ${f.text}`);

  if (lines.length === 0) return "";
  return `## Recent Conversation\n\n${lines.join("\n")}`;
}

/**
 * Assemble the full system prompt for a native reasoning turn.
 *
 * Sections are joined with `\n\n---\n\n` separators. Missing sections
 * are silently skipped so a barebones agent (no SOUL.md, no character
 * system) still gets a coherent prompt.
 */
export async function assembleSystemPrompt(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<string> {
  const parts: string[] = [];

  const charSystem =
    typeof runtime.character?.system === "string"
      ? runtime.character.system.trim()
      : "";
  if (charSystem) parts.push(charSystem);
  parts.push(CHANNEL_GAG_HARD_RULE);

  const workspaceDir = getWorkspaceDir();
  for (const { file, header } of IDENTITY_FILES) {
    const abs = path.join(workspaceDir, file);
    const content = await readCachedFile(abs);
    if (content && content.trim().length > 0) {
      parts.push(`${header}\n\n${content.trim()}`);
    }
  }

  if (message.roomId) {
    const ctx = await getRoomContext(runtime, message.roomId, message.id);
    if (ctx) parts.push(ctx);
  }

  return parts.join("\n\n---\n\n");
}
