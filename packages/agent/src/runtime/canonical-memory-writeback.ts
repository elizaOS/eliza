/**
 * Canonical memory writeback: controlled, provenance-carrying writes to an
 * approved canonical-memory root (daily notes + handoff), deny-by-default.
 *
 * This is the write-side counterpart of canonical file boot (#16700). A
 * sovereign agent runtime that boots identity from canonical files needs a
 * narrow, auditable path for writing daily memory back to disk:
 *
 * - Exactly one approved write root (`CANONICAL_MEMORY_WRITE_ROOT` or config),
 *   plus an allowlist of file patterns inside it. Unset root = every write
 *   denied. Every denial carries an auditable reason.
 * - Facts append to the current daily file with provenance (timestamp, source,
 *   conversation ref). Re-submitting the same fact id is a no-op, giving
 *   exactly-once journal semantics under retry.
 * - Corrections reference a prior fact id and append a superseding entry;
 *   history is append-only, never rewritten in place.
 * - Writes are atomic (temp file + rename in the same directory), so a crash
 *   between write and rename leaves either the old or the new complete file,
 *   never a torn one.
 *
 * @module canonical-memory-writeback
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { logger } from "@elizaos/core";

/** Provenance attached to every journal entry. */
export interface FactProvenance {
  /** Source surface, e.g. "discord", "web", "test". */
  source: string;
  /** Stable id of the submitting user (platform-scoped). */
  userId: string;
  /** Conversation/room/channel reference for traceability. */
  conversationRef?: string;
}

/** A user-provided fact to record in canonical daily memory. */
export interface FactWrite {
  /**
   * Caller-stable idempotency key. Re-submitting the same id never creates a
   * duplicate entry. Defaults to a hash of (text, provenance.userId) when the
   * caller cannot supply one.
   */
  factId?: string;
  /** The fact text (single logical statement). */
  text: string;
  provenance: FactProvenance;
  /** When set, this entry supersedes the referenced prior fact id. */
  supersedesFactId?: string;
}

export type WritebackDenialReason =
  | "write-root-unset"
  | "write-root-escape"
  | "pattern-not-allowed"
  | "invalid-fact";

export interface WritebackResult {
  ok: boolean;
  /** "appended" when written, "duplicate" for an exactly-once no-op. */
  outcome?: "appended" | "duplicate";
  factId?: string;
  file?: string;
  denialReason?: WritebackDenialReason;
  /** Human-readable audit line for denials. */
  auditReason?: string;
}

export interface CanonicalMemoryWritebackConfig {
  /** Absolute path of the single approved write root. */
  writeRoot?: string;
  /**
   * Allowed relative file patterns inside the root. Defaults cover daily
   * notes (`memory/YYYY-MM-DD.md` style) and the handoff file.
   */
  allowedPatterns?: RegExp[];
  /** Clock override for tests. */
  now?: () => Date;
}

const DEFAULT_ALLOWED_PATTERNS: RegExp[] = [
  /^(?:memory\/)?\d{4}-\d{2}-\d{2}\.md$/,
  /^(?:memory\/)?HANDOFF\.md$/,
];

interface JournalEntry {
  factId: string;
  text: string;
  provenance: FactProvenance & { recordedAt: string };
  supersedesFactId?: string;
}

function resolveWriteRoot(
  config: CanonicalMemoryWritebackConfig,
): string | undefined {
  const root = config.writeRoot ?? process.env.CANONICAL_MEMORY_WRITE_ROOT;
  if (!root || root.trim() === "") return undefined;
  return path.resolve(root);
}

function deriveFactId(fact: FactWrite): string {
  if (fact.factId && fact.factId.trim() !== "") return fact.factId.trim();
  return createHash("sha256")
    .update(fact.text)
    .update("\u0000")
    .update(fact.provenance.userId)
    .digest("hex")
    .slice(0, 32);
}

function dailyFileRelPath(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `memory/${y}-${m}-${d}.md`;
}

/** Marker line prefix used to detect prior fact ids in a daily file. */
const FACT_MARKER = "<!-- fact:";

function formatEntry(entry: JournalEntry): string {
  const meta = `${FACT_MARKER}${entry.factId}${
    entry.supersedesFactId ? ` supersedes:${entry.supersedesFactId}` : ""
  } -->`;
  const prov = `provenance: ${entry.provenance.source} user=${entry.provenance.userId}${
    entry.provenance.conversationRef
      ? ` ref=${entry.provenance.conversationRef}`
      : ""
  } at=${entry.provenance.recordedAt}`;
  const label = entry.supersedesFactId ? "CORRECTION" : "FACT";
  return `\n${meta}\n- **${label}:** ${entry.text}\n  - ${prov}\n`;
}

/**
 * Atomically write `content` to `filePath` via same-directory temp + rename.
 * A crash between write and rename leaves the previous file intact.
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

function deny(reason: WritebackDenialReason, audit: string): WritebackResult {
  logger.warn(`[canonical-memory-writeback] denied (${reason}): ${audit}`);
  return { ok: false, denialReason: reason, auditReason: audit };
}

/**
 * Validate that `relPath` stays inside the write root and matches an allowed
 * pattern. Returns the absolute target path or a denial.
 */
export function authorizeWrite(
  relPath: string,
  config: CanonicalMemoryWritebackConfig = {},
): { ok: true; absPath: string } | { ok: false; result: WritebackResult } {
  const root = resolveWriteRoot(config);
  if (!root) {
    return {
      ok: false,
      result: deny(
        "write-root-unset",
        `no approved write root configured; refusing write of "${relPath}"`,
      ),
    };
  }
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return {
      ok: false,
      result: deny(
        "write-root-escape",
        `path "${relPath}" resolves outside approved root "${root}"`,
      ),
    };
  }
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const patterns = config.allowedPatterns ?? DEFAULT_ALLOWED_PATTERNS;
  if (!patterns.some((p) => p.test(rel))) {
    return {
      ok: false,
      result: deny(
        "pattern-not-allowed",
        `path "${rel}" does not match any allowed canonical-memory pattern`,
      ),
    };
  }
  return { ok: true, absPath: abs };
}

/**
 * Record a user-provided fact (or correction) in today's daily file with
 * provenance. Exactly-once per fact id; corrections append a superseding
 * entry rather than rewriting history.
 */
export async function recordCanonicalFact(
  fact: FactWrite,
  config: CanonicalMemoryWritebackConfig = {},
): Promise<WritebackResult> {
  if (!fact.text || fact.text.trim() === "") {
    return deny("invalid-fact", "fact text is empty");
  }
  if (!fact.provenance?.source || !fact.provenance?.userId) {
    return deny("invalid-fact", "fact provenance requires source and userId");
  }

  const now = (config.now ?? (() => new Date()))();
  const relPath = dailyFileRelPath(now);
  const authz = authorizeWrite(relPath, config);
  if (!authz.ok) return authz.result;

  const factId = deriveFactId(fact);
  let existing = "";
  try {
    existing = await fs.readFile(authz.absPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (
    existing.includes(`${FACT_MARKER}${factId} `) ||
    existing.includes(`${FACT_MARKER}${factId} -->`)
  ) {
    return { ok: true, outcome: "duplicate", factId, file: authz.absPath };
  }

  const entry: JournalEntry = {
    factId,
    text: fact.text.trim(),
    provenance: { ...fact.provenance, recordedAt: now.toISOString() },
    ...(fact.supersedesFactId
      ? { supersedesFactId: fact.supersedesFactId }
      : {}),
  };

  const header =
    existing === ""
      ? `# ${relPath.replace(/^memory\//, "").replace(/\.md$/, "")}\n`
      : "";
  await writeFileAtomic(authz.absPath, existing + header + formatEntry(entry));
  return { ok: true, outcome: "appended", factId, file: authz.absPath };
}

/**
 * List entries currently recorded for a given day (parsing the marker lines).
 * Superseded facts are reported with `supersededBy` so an indexed store can
 * mark rather than duplicate them.
 */
export async function readCanonicalFacts(
  day: Date,
  config: CanonicalMemoryWritebackConfig = {},
): Promise<
  Array<{ factId: string; supersedesFactId?: string; supersededBy?: string }>
> {
  const relPath = dailyFileRelPath(day);
  const authz = authorizeWrite(relPath, config);
  if (!authz.ok) return [];
  let content = "";
  try {
    content = await fs.readFile(authz.absPath, "utf8");
  } catch {
    return [];
  }
  const out: Array<{
    factId: string;
    supersedesFactId?: string;
    supersededBy?: string;
  }> = [];
  const re = /<!-- fact:([0-9a-zA-Z_-]+)(?: supersedes:([0-9a-zA-Z_-]+))? -->/g;
  for (const m of content.matchAll(re)) {
    out.push({ factId: m[1], ...(m[2] ? { supersedesFactId: m[2] } : {}) });
  }
  for (const e of out) {
    const successor = out.find((s) => s.supersedesFactId === e.factId);
    if (successor) e.supersededBy = successor.factId;
  }
  return out;
}
