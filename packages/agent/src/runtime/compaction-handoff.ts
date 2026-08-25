/**
 * Compaction handoff generator: turns a long session transcript into a
 * BOUNDED handoff document that preserves the load-bearing carry-forward
 * state (decisions, todos/pending actions, open threads) with provenance,
 * then writes it atomically to the approved canonical-memory write root.
 *
 * This is the COMPACTION/handoff-regeneration side of the sovereign memory
 * story. Its siblings:
 *   - #16700 canonical file boot (read identity from files)
 *   - #16702 canonical memory writeback (append daily facts with provenance)
 *
 * Where writeback records *individual* facts as they happen, a handoff is the
 * periodic *summary* the next session reads first. When a session grows past a
 * turn/token budget, compaction runs, and the handoff must:
 *
 * - Preserve every seeded decision/todo/open-thread. These are load-bearing;
 *   dropping one silently is the failure mode we most want to prevent, so
 *   extraction is deterministic (marker-based) rather than model-dependent.
 * - Stay BOUNDED. The handoff is what the next session pays for on every boot,
 *   so it is size-capped. Preserved carry-forward items are never truncated;
 *   only the free-form recent-context tail is trimmed to fit the cap.
 * - Rotate ATOMICALLY. A crash between temp-write and rename leaves either the
 *   previous handoff or the new one, never a torn file. Reuses #16702's
 *   `writeFileAtomic`.
 * - Be idempotent-ish. Re-running compaction on an already-compacted session
 *   does not grow the handoff without bound; the preserved sets are de-duped
 *   and the tail is re-derived, not appended.
 *
 * File-firewall: all writes go through #16702's `authorizeWrite`, which is
 * deny-by-default and confined to the approved write root. The handoff path is
 * already allowlisted there (`HANDOFF.md`).
 *
 * @module compaction-handoff
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "@elizaos/core";

import {
  authorizeWrite,
  type CanonicalMemoryWritebackConfig,
} from "./canonical-memory-writeback.ts";
import type {
  CompactorMessage,
  CompactorTranscript,
} from "./conversation-compactor.types.ts";

/** Provenance for a single carried-forward item. */
export interface CarryProvenance {
  /** 1-based turn index the item was first seen at. */
  turn: number;
  /** Role that authored the turn ("user" | "assistant" | ...). */
  role: string;
  /** Optional epoch ms of the source turn. */
  timestamp?: number;
}

/** A load-bearing item preserved across the handoff. */
export interface CarryItem {
  /** Stable id derived from normalized text; used for de-dup + idempotency. */
  id: string;
  /** The item text (single logical statement). */
  text: string;
  provenance: CarryProvenance;
}

export type HandoffKind = "decision" | "todo" | "open_thread";

export interface HandoffDocument {
  decisions: CarryItem[];
  todos: CarryItem[];
  openThreads: CarryItem[];
  /** Trimmed recent-context tail (most recent turns, may be dropped to fit cap). */
  recentContext: string[];
  /** Rendered markdown, guaranteed <= maxBytes. */
  markdown: string;
  /** Byte length of `markdown`. */
  bytes: number;
  /** True when the recent-context tail was trimmed to satisfy the cap. */
  tailTrimmed: boolean;
  /** Source session stats, for auditing. */
  stats: {
    turnCount: number;
    decisionCount: number;
    todoCount: number;
    openThreadCount: number;
  };
}

export interface HandoffGeneratorConfig extends CanonicalMemoryWritebackConfig {
  /**
   * Hard cap on the rendered handoff size in bytes. Preserved carry-forward
   * items are never dropped to meet this; only the recent-context tail is
   * trimmed. Defaults to 16 KiB.
   */
  maxBytes?: number;
  /**
   * How many recent turns to consider for the (trimmable) recent-context tail
   * before the cap is applied. Defaults to 12.
   */
  recentContextTurns?: number;
  /** Handoff file path relative to the approved write root. Default HANDOFF.md. */
  handoffRelPath?: string;
}

const DEFAULT_MAX_BYTES = 16 * 1024;
const DEFAULT_RECENT_TURNS = 12;
const DEFAULT_HANDOFF_REL = "HANDOFF.md";

/**
 * Atomically write `content` to `filePath` via same-directory temp + rename
 * (mirrors #16702's writeback atomicity). A crash between write and rename
 * leaves the previous file intact — never a torn one. Kept local here so the
 * handoff module owns its write path without widening the writeback surface.
 */
async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Marker syntaxes we extract carry-forward items from, deterministically.
 * These mirror how a session seeds durable state:
 *
 *   DECISION: ...            / [decision] ...
 *   TODO: ...   / TO-DO: ... / [todo] ...  / - [ ] ...
 *   OPEN THREAD: ...         / [open-thread] ...  / OPEN: ...
 *
 * Case-insensitive; leading list bullets tolerated.
 */
const DECISION_RE = /^\s*(?:[-*]\s*)?(?:\[decision\]|decision)\s*:?\s*(.+)$/i;
const TODO_RE =
  /^\s*(?:[-*]\s*)?(?:\[todo\]|\[\s?\]|todo|to-?do)\s*:?\s*(.+)$/i;
const OPEN_THREAD_RE =
  /^\s*(?:[-*]\s*)?(?:\[open-?thread\]|open[ -]?thread|open)\s*:?\s*(.+)$/i;

function normalizeItemText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[;:,.\s]+$/g, "")
    .trim();
}

function itemId(kind: HandoffKind, text: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\u0000")
    .update(normalizeItemText(text).toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function messageText(m: CompactorMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

/**
 * Deterministically extract decisions / todos / open-threads from a transcript.
 * De-duplicated by normalized text (first occurrence keeps provenance).
 */
export function extractCarryItems(transcript: CompactorTranscript): {
  decisions: CarryItem[];
  todos: CarryItem[];
  openThreads: CarryItem[];
} {
  const decisions = new Map<string, CarryItem>();
  const todos = new Map<string, CarryItem>();
  const openThreads = new Map<string, CarryItem>();

  transcript.messages.forEach((m, idx) => {
    const turn = idx + 1;
    const prov = (): CarryProvenance => ({
      turn,
      role: m.role,
      ...(typeof m.timestamp === "number" ? { timestamp: m.timestamp } : {}),
    });
    for (const rawLine of messageText(m).split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      // Order matters: open-thread and todo patterns can both start with a
      // bracket; test the most specific ("[decision]"/"[open-thread]"/"[todo]")
      // via their dedicated regexes. A line matches at most one kind.
      const dm = DECISION_RE.exec(line);
      if (dm) {
        const text = normalizeItemText(dm[1]);
        if (text) {
          const id = itemId("decision", text);
          if (!decisions.has(id))
            decisions.set(id, { id, text, provenance: prov() });
        }
        continue;
      }
      const om = OPEN_THREAD_RE.exec(line);
      if (om) {
        const text = normalizeItemText(om[1]);
        if (text) {
          const id = itemId("open_thread", text);
          if (!openThreads.has(id))
            openThreads.set(id, { id, text, provenance: prov() });
        }
        continue;
      }
      const tm = TODO_RE.exec(line);
      if (tm) {
        const text = normalizeItemText(tm[1]);
        if (text) {
          const id = itemId("todo", text);
          if (!todos.has(id)) todos.set(id, { id, text, provenance: prov() });
        }
      }
    }
  });

  return {
    decisions: [...decisions.values()],
    todos: [...todos.values()],
    openThreads: [...openThreads.values()],
  };
}

function renderCarrySection(title: string, items: CarryItem[]): string {
  if (items.length === 0) return `## ${title}\n_none_\n`;
  const lines = items.map((it) => {
    const ts = it.provenance.timestamp
      ? ` t=${new Date(it.provenance.timestamp).toISOString()}`
      : "";
    return `- ${it.text} <!-- ${it.id} turn=${it.provenance.turn} by=${it.provenance.role}${ts} -->`;
  });
  return `## ${title}\n${lines.join("\n")}\n`;
}

function recentContextTail(
  transcript: CompactorTranscript,
  turns: number,
): string[] {
  const msgs = transcript.messages;
  const start = Math.max(0, msgs.length - turns);
  const out: string[] = [];
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    const text = normalizeItemText(messageText(m));
    if (!text) continue;
    out.push(`- (${i + 1}/${m.role}) ${text}`);
  }
  return out;
}

function renderHandoff(
  decisions: CarryItem[],
  todos: CarryItem[],
  openThreads: CarryItem[],
  recentContext: string[],
  meta: { generatedAt: string; turnCount: number },
): string {
  const head =
    `# HANDOFF\n` +
    `<!-- generated-at=${meta.generatedAt} turns=${meta.turnCount} -->\n` +
    `_Bounded handoff. Preserved items are load-bearing; recent context is best-effort._\n`;
  const body = [
    renderCarrySection("Decisions", decisions),
    renderCarrySection("Todos", todos),
    renderCarrySection("Open threads", openThreads),
  ].join("\n");
  const tail =
    `\n## Recent context\n` +
    (recentContext.length ? `${recentContext.join("\n")}\n` : "_none_\n");
  return `${head}\n${body}${tail}`;
}

/**
 * Build a bounded handoff document from a session transcript. Pure: performs
 * no I/O, so it is safe to unit test and to call before authorizing a write.
 *
 * Preserved carry-forward items (decisions/todos/open-threads) are ALWAYS
 * fully included. Only the recent-context tail is trimmed — one turn at a time
 * from the oldest — until the rendered markdown fits `maxBytes`.
 */
export function buildHandoffDocument(
  transcript: CompactorTranscript,
  config: HandoffGeneratorConfig = {},
): HandoffDocument {
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const recentTurns = config.recentContextTurns ?? DEFAULT_RECENT_TURNS;
  const now = (config.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  const turnCount = transcript.messages.length;

  const { decisions, todos, openThreads } = extractCarryItems(transcript);
  let recentContext = recentContextTail(transcript, recentTurns);

  const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
  let markdown = renderHandoff(decisions, todos, openThreads, recentContext, {
    generatedAt,
    turnCount,
  });
  let tailTrimmed = false;

  // Trim the recent-context tail (oldest first) until we fit the cap. Preserved
  // carry-forward items are never dropped — the handoff can exceed the cap only
  // if the preserved sets alone already do, in which case we surface it rather
  // than silently lose load-bearing state.
  while (bytesOf(markdown) > maxBytes && recentContext.length > 0) {
    recentContext = recentContext.slice(1);
    tailTrimmed = true;
    markdown = renderHandoff(decisions, todos, openThreads, recentContext, {
      generatedAt,
      turnCount,
    });
  }

  const bytes = bytesOf(markdown);
  if (bytes > maxBytes) {
    logger.warn(
      `[compaction-handoff] preserved carry-forward exceeds cap ` +
        `(${bytes} > ${maxBytes} bytes); not truncating load-bearing state`,
    );
  }

  return {
    decisions,
    todos,
    openThreads,
    recentContext,
    markdown,
    bytes,
    tailTrimmed,
    stats: {
      turnCount,
      decisionCount: decisions.length,
      todoCount: todos.length,
      openThreadCount: openThreads.length,
    },
  };
}

export type HandoffWriteDenial =
  | "write-root-unset"
  | "write-root-escape"
  | "pattern-not-allowed";

export interface HandoffWriteResult {
  ok: boolean;
  file?: string;
  bytes?: number;
  document?: HandoffDocument;
  denialReason?: HandoffWriteDenial;
  auditReason?: string;
}

/**
 * Generate a bounded handoff for `transcript` and write it atomically to the
 * approved write root (via #16702's `authorizeWrite` + `writeFileAtomic`),
 * replacing any prior handoff. Rotation is atomic: a crash between temp-write
 * and rename leaves the old or new complete file, never a torn one.
 *
 * Idempotent-ish: re-running on the same (or an already-compacted) session
 * regenerates the same bounded doc; the file does not grow without bound
 * because the handoff is *replaced*, not appended.
 */
export async function generateAndWriteHandoff(
  transcript: CompactorTranscript,
  config: HandoffGeneratorConfig = {},
): Promise<HandoffWriteResult> {
  const relPath = config.handoffRelPath ?? DEFAULT_HANDOFF_REL;
  const authz = authorizeWrite(relPath, config);
  if (!authz.ok) {
    return {
      ok: false,
      denialReason: authz.result.denialReason as HandoffWriteDenial,
      auditReason: authz.result.auditReason,
    };
  }

  const document = buildHandoffDocument(transcript, config);
  await writeFileAtomic(authz.absPath, document.markdown);
  return { ok: true, file: authz.absPath, bytes: document.bytes, document };
}
