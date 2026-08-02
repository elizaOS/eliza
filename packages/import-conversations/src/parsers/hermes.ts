/**
 * Parser for Hermes agent home directories (per-session files plus optional
 * `memories/*.md` notes). Registers as a `ConversationImporter` and normalizes
 * each session into the shared message contract; chain-of-thought reasoning and
 * `tool` messages are opt-in, daily memory notes are on by default.
 */

import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type { ConversationImporter } from "../core/registry.ts";
import type {
  NormalizedConversation,
  NormalizedMessage,
  NormalizedRole,
} from "../core/types.ts";

export type ParseOptions = {
  /**
   * Keep assistant chain-of-thought (`reasoning`) text. Off by default: CoT is
   * privacy-sensitive and noisy. When true, reasoning is appended to the
   * assistant message text under a fenced block.
   */
  includeReasoning?: boolean;
  /**
   * Keep `tool` role messages as annotated context. Off by default. When true,
   * tool outputs are emitted as `role: "tool"` messages with
   * `annotations.toolName` set where derivable.
   */
  includeToolMessages?: boolean;
  /**
   * Include agent-authored daily memory notes (Hermes `memories/*.md`) as
   * date-titled single-note conversations. On by default (cheap, high value).
   */
  includeMemories?: boolean;
};

const SOURCE = "hermes" as const;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Shape of a Hermes session_meta header line (first line of a session file).
 * `model` is often an empty string; `platform` records the connector (discord,
 * cli, etc.). `tools` is a schema dump we skip.
 */
type HermesSessionMeta = {
  role: "session_meta";
  tools?: unknown[];
  model?: string;
  platform?: string;
  timestamp?: string;
};

/**
 * A single Hermes tool_call as embedded on assistant lines. We only need the
 * function name to derive `annotations.toolName`.
 */
type HermesToolCall = {
  function?: { name?: string };
};

/** A Hermes message line (user / assistant / tool). */
type HermesMessageLine = {
  role: string;
  content?: string;
  reasoning?: string | null;
  finish_reason?: string;
  timestamp?: string;
  tool_call_id?: string;
  tool_calls?: HermesToolCall[];
};

const DEFAULT_OPTIONS: Required<ParseOptions> = {
  includeReasoning: false,
  includeToolMessages: false,
  includeMemories: true,
};

/** Parse an ISO timestamp to epoch ms, or undefined if absent/unparseable. */
function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Map a raw Hermes role string to a normalized role. */
function normalizeRole(role: string): NormalizedRole | undefined {
  if (role === "user" || role === "assistant" || role === "tool") return role;
  if (role === "system") return "system";
  return undefined;
}

/**
 * Derive a stable, human-legible conversation id + title from a session file
 * name like `20260319_025534_bd09d0df.jsonl`.
 */
function sessionIdFromFilename(fileName: string): string {
  return fileName.replace(/\.jsonl$/i, "");
}

function titleFromSessionId(sessionId: string): string {
  // 20260319_025534_bd09d0df -> "Hermes session 2026-03-19 02:55:34"
  const m = sessionId.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return `Hermes session ${y}-${mo}-${d} ${h}:${mi}:${s}`;
  }
  return `Hermes session ${sessionId}`;
}

/**
 * Convert one parsed Hermes line into a NormalizedMessage, or undefined if the
 * line should be dropped (unknown role, or a tool line when tools are excluded).
 */
function lineToMessage(
  parsed: HermesMessageLine,
  opts: Required<ParseOptions>,
): NormalizedMessage | undefined {
  const role = normalizeRole(parsed.role);
  if (!role) return undefined;

  if (role === "tool" && !opts.includeToolMessages) return undefined;

  const createdAt = toEpochMs(parsed.timestamp);
  let text = typeof parsed.content === "string" ? parsed.content : "";

  // Drop chain-of-thought by default; optionally append it as a fenced block.
  if (
    opts.includeReasoning &&
    typeof parsed.reasoning === "string" &&
    parsed.reasoning.length > 0
  ) {
    text = `${text}\n\n\`\`\`reasoning\n${parsed.reasoning}\n\`\`\``;
  }

  const message: NormalizedMessage = { role, text, createdAt };

  // Assistant lines that invoke tools: record the (first) tool name.
  if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
    const toolName = parsed.tool_calls[0]?.function?.name;
    if (toolName) {
      message.annotations = { ...(message.annotations ?? {}), toolName };
    }
  }

  // Tool result lines carry a tool_call_id but not the name; surface the id as
  // the toolName annotation so downstream can correlate.
  if (role === "tool" && parsed.tool_call_id) {
    message.annotations = {
      ...(message.annotations ?? {}),
      toolName: parsed.tool_call_id,
    };
  }

  return message;
}

/**
 * Stream a single Hermes session file, yielding one NormalizedConversation.
 *
 * Reads line-by-line via readline (never buffers the whole file). The first
 * line is either a `session_meta` header (skipped as a message but used for
 * conversation meta) OR — for older/partial sessions — a plain message; both
 * are handled. Malformed JSON lines are skipped, not fatal.
 */
async function parseSessionFile(
  filePath: string,
  opts: Required<ParseOptions>,
): Promise<NormalizedConversation> {
  const fileName = path.basename(filePath);
  const sessionId = sessionIdFromFilename(fileName);

  const messages: NormalizedMessage[] = [];
  let meta: HermesSessionMeta | undefined;
  let firstLineSeen = false;
  // Track message-time bounds incrementally (never spread a big array into
  // Math.min/max — that overflows the call stack on large sessions, which is
  // exactly the streaming case this parser targets).
  let minMessageTime: number | undefined;
  let maxMessageTime: number | undefined;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      let parsed: HermesMessageLine | HermesSessionMeta;
      try {
        parsed = JSON.parse(line);
      } catch {
        // error-policy:J3 each JSONL line is untrusted input; a truncated/
        // corrupt line (common on the still-appending tail of a live session
        // log) is skipped so it does not abort import of the valid lines.
        continue;
      }

      if (!firstLineSeen) {
        firstLineSeen = true;
        if ((parsed as HermesSessionMeta).role === "session_meta") {
          meta = parsed as HermesSessionMeta;
          continue; // header consumed; not a message
        }
        // No meta header (older session) — fall through to treat as a message.
      }

      const message = lineToMessage(parsed as HermesMessageLine, opts);
      if (message) {
        messages.push(message);
        if (typeof message.createdAt === "number") {
          if (
            minMessageTime === undefined ||
            message.createdAt < minMessageTime
          ) {
            minMessageTime = message.createdAt;
          }
          if (
            maxMessageTime === undefined ||
            message.createdAt > maxMessageTime
          ) {
            maxMessageTime = message.createdAt;
          }
        }
      }
    }
  } finally {
    rl.close();
  }

  // Conversation timing: prefer the meta header timestamp; fall back to the
  // first/last message timestamps we saw. Bounds are accumulated incrementally
  // above so this stays O(1) memory and never spreads a large array.
  const metaCreatedAt = toEpochMs(meta?.timestamp);
  const createdAt = metaCreatedAt ?? minMessageTime;
  const updatedAt = maxMessageTime ?? createdAt;

  const model = meta?.model && meta.model.length > 0 ? meta.model : undefined;
  const platform =
    meta?.platform && meta.platform.length > 0 ? meta.platform : undefined;

  const conversation: NormalizedConversation = {
    sourceConversationId: sessionId,
    title: titleFromSessionId(sessionId),
    createdAt,
    updatedAt,
    messages,
    meta: {
      model,
      tags: platform ? [`platform:${platform}`] : undefined,
    },
  };

  return conversation;
}

/**
 * Parse one Hermes daily memory note (`memories/YYYY-MM-DD.md`) into a
 * date-titled conversation with a single system/note message. These are
 * agent-authored context, cheap to include, and high value per token.
 */
async function parseMemoryFile(
  filePath: string,
): Promise<NormalizedConversation | undefined> {
  const fileName = path.basename(filePath);
  const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  const dateTag = dateMatch?.[1];

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    // error-policy:J3 the path came from readdir moments ago; ENOENT means the
    // note was removed under us (benign race in a live agent home) so we skip
    // it. Any other read failure (EACCES, EIO, ...) is a real error and must
    // surface rather than silently dropping the note.
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (content.trim().length === 0) return undefined;

  const createdAt = dateTag ? toEpochMs(`${dateTag}T00:00:00Z`) : undefined;

  return {
    sourceConversationId: `memory:${fileName.replace(/\.md$/i, "")}`,
    title: dateTag ? `Hermes daily note ${dateTag}` : `Hermes note ${fileName}`,
    createdAt,
    updatedAt: createdAt,
    messages: [
      {
        role: "system",
        text: content,
        createdAt,
        annotations: { toolName: "hermes-memory-note" },
      },
    ],
    meta: {
      tags: [
        "memory-note",
        ...(dateTag ? [`date:${dateTag.slice(0, 7)}`] : []),
      ],
    },
  };
}

/** Resolve the sessions/ dir for a given Hermes home (or a sessions dir itself). */
function resolveSessionsDir(input: string): string {
  const base = path.basename(input);
  if (base === "sessions") return input;
  return path.join(input, "sessions");
}

function resolveMemoriesDir(input: string): string {
  const base = path.basename(input);
  if (base === "sessions") return path.join(path.dirname(input), "memories");
  return path.join(input, "memories");
}

/**
 * detect: true when `input` looks like a Hermes home. We accept either a home
 * dir containing `sessions/` with `.jsonl` files, or a `sessions` dir directly.
 * We also confirm the Hermes signature by peeking the first line of one session
 * file for a `session_meta` header OR a plausible message shape.
 */
async function detect(input: string): Promise<boolean> {
  try {
    const st = await stat(input);
    if (!st.isDirectory()) return false;
  } catch (error) {
    // error-policy:J3 an absent path is "not a Hermes home"; any other stat
    // failure (EACCES, EIO, ...) is a real I/O error and must surface.
    if (isNotFound(error)) return false;
    throw error;
  }

  const sessionsDir = resolveSessionsDir(input);
  if (!existsSync(sessionsDir)) return false;

  // sessionsDir existed a moment ago (existsSync above): a readdir failure here
  // is a real I/O error on required input, not "not a Hermes home" — surface it
  // rather than silently reporting the export as unrecognized.
  const entries = await readdir(sessionsDir);
  const jsonlFiles = entries.filter((f) => f.toLowerCase().endsWith(".jsonl"));
  const firstJsonl = jsonlFiles[0];
  if (!firstJsonl) return false;

  // Peek the first non-empty line of the first session file for the signature.
  const sample = path.join(sessionsDir, firstJsonl);
  const rl = createInterface({
    input: createReadStream(sample, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { role?: string };
        // session_meta header, or a recognizable message role.
        return (
          parsed.role === "session_meta" ||
          parsed.role === "user" ||
          parsed.role === "assistant" ||
          parsed.role === "tool"
        );
      } catch {
        // error-policy:J3 the signature line is untrusted input; a non-JSON
        // first line means this file does not carry the Hermes signature, so
        // the input is not a recognizable Hermes home (probe returns false).
        return false;
      }
    }
  } finally {
    rl.close();
  }
  return false;
}

/**
 * parse: streaming async generator. Yields one NormalizedConversation per
 * session file (sorted by filename = chronological), then optionally the daily
 * memory notes. Each session is streamed line-by-line; we never hold more than
 * one session's messages in memory at a time, and conversations are yielded
 * incrementally as each file completes.
 */
async function* parse(
  input: string,
  options?: ParseOptions,
): AsyncIterable<NormalizedConversation> {
  const opts: Required<ParseOptions> = { ...DEFAULT_OPTIONS, ...options };

  const sessionsDir = resolveSessionsDir(input);
  if (existsSync(sessionsDir)) {
    // existsSync passed: a readdir failure is a real I/O error, not an empty
    // session set. Surface it rather than silently importing zero sessions.
    const entries = await readdir(sessionsDir);
    const sessionFiles = entries
      .filter((f) => f.toLowerCase().endsWith(".jsonl"))
      .sort(); // filenames are timestamp-prefixed => chronological

    for (const fileName of sessionFiles) {
      const filePath = path.join(sessionsDir, fileName);
      yield await parseSessionFile(filePath, opts);
    }
  }

  if (opts.includeMemories) {
    const memoriesDir = resolveMemoriesDir(input);
    if (existsSync(memoriesDir)) {
      // existsSync passed: a readdir failure is a real I/O error on the
      // memories dir, not "no notes". Surface it rather than dropping them.
      const entries = await readdir(memoriesDir);
      const memoryFiles = entries
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/i.test(f))
        .sort();

      for (const fileName of memoryFiles) {
        const conv = await parseMemoryFile(path.join(memoriesDir, fileName));
        if (conv) yield conv;
      }
    }
  }
}

export const hermesParser: ConversationImporter<string> = {
  source: SOURCE,
  detect,
  parse,
};

// Named exports for direct use + testing of internals.
export { detect, parse };
export default hermesParser;
