/**
 * OpenClaw agent-home reader.
 *
 * Reads a file-based OpenClaw ("moltbot") agent home and classifies its
 * contents into a typed source object the migration pipeline consumes. Pure
 * filesystem + classification: NO network, NO side effects. Missing files are
 * tolerated (returned as undefined / empty) so partial homes still migrate.
 *
 * OCPlatform homes come in several version-shapes (see OC-VERSION-AUDIT.md):
 *   FLAT  (.moltbot):  <home>/SOUL.md IDENTITY.md AGENTS.md USER.md TOOLS.md
 *                      <home>/MEMORY.md (or legacy memory.md) HEARTBEAT.md
 *                      <home>/memory/YYYY-MM-DD.md + <named>.md
 *   LEANER (.hermes):  <home>/SOUL.md + AGENTS.md only (no IDENTITY/USER/TOOLS)
 *                      <home>/memory/<persona>-awareness.md, <persona>-thoughts.md
 *   NESTED:            <home>/workspace/... (same files, one level down)
 *   SQLITE (.ocplatform builder):  <home>/memory/<agent>.sqlite (a vector
 *                      index, NOT markdown). chunks.text holds the prose.
 *   <home>/secrets/  keys, firewalled, never read here.
 *
 * The reader is tolerant of missing files and NEVER silently emits empty for a
 * sqlite home: it detects + warns, and best-effort reads chunks.text when the
 * node:sqlite builtin is available (no heavy dependency added).
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

// ESM-safe require for the optional node:sqlite builtin (the bundle is ESM, so
// a bare `require` is undefined; createRequire gives us one that works).
const nodeRequire = createRequire(import.meta.url);

export interface OcDailyLog {
  /** ISO date parsed from the filename (YYYY-MM-DD), or null if unparseable. */
  date: string | null;
  /** Epoch ms of the date at UTC midnight, or 0 if unparseable. */
  epochMs: number;
  filename: string;
  text: string;
}

export interface OcNamedMemory {
  /** basename without extension, e.g. "conversation-playbook" */
  key: string;
  filename: string;
  text: string;
}

/** A detected sqlite memory store (vector index) inside <home>/memory. */
export interface OcSqliteStore {
  /** absolute path to the .sqlite file */
  file: string;
  /** basename without extension, e.g. "builder-2" */
  name: string;
  /** byte size on disk */
  bytes: number;
}

export interface OcAgentSource {
  agentId: string;
  home: string;
  /** SOUL.md - core voice/values. */
  soul?: string;
  /** IDENTITY.md - name/vibe/appearance/personality. */
  identity?: string;
  /** AGENTS.md - behavioral + ops rules. */
  agents?: string;
  /** USER.md - about the human. FIREWALLED (personal). */
  user?: string;
  /** TOOLS.md - infra/keys/notes → plugin config, NOT persona. */
  tools?: string;
  /** MEMORY.md (or legacy memory.md): curated long-term memory. */
  curatedMemory?: string;
  /** Which root-memory filename was found ("MEMORY.md" | "memory.md" | undefined). */
  curatedMemoryFile?: string;
  /** HEARTBEAT.md - heartbeat checklist. */
  hbSignal?: string;
  /** <agent>-awareness.md - live open-threads / relationship state. */
  awareness?: string;
  /** memory/YYYY-MM-DD.md - daily logs, sorted newest-first. */
  dailyLogs: OcDailyLog[];
  /**
   * memory/<named>.md - non-daily memory files (journals, playbooks, channel
   * guides, project/routine docs). Keyed by basename.
   */
  namedMemory: OcNamedMemory[];
  /** Whether a secrets/ dir exists (contents intentionally NOT read). */
  hasSecretsDir: boolean;
  /**
   * sqlite memory stores detected in <home>/memory (newer/builder layout).
   * Empty for pure-markdown homes.
   */
  sqliteStores: OcSqliteStore[];
  /**
   * Whether sqlite memory was detected but NOT ingested (because node:sqlite is
   * unavailable). Drives a loud warning so we never silently emit empty.
   */
  sqliteUningested: boolean;
  /** Non-fatal warnings surfaced to the user (e.g. sqlite-not-read). */
  warnings: string[];
}

const DAILY_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

/** Canonical + legacy root-memory filenames (mirrors OC root-memory-files.ts). */
const ROOT_MEMORY_CANDIDATES = ["MEMORY.md", "memory.md"] as const;

/**
 * Candidate sub-roots within a home, in priority order. OpenClaw homes come
 * in two shapes: FLAT (`<home>/SOUL.md`, `<home>/memory/`) and NESTED
 * (`<home>/workspace/SOUL.md`, `<home>/workspace.default/...`). We probe in this
 * order so a nested home doesn't silently migrate to an empty character.
 * (Mirrors Hermes's `source_candidate` multi-path probing.)
 */
const HOME_SUBROOTS = ["", "workspace", "workspace.default"] as const;

function readIfPresent(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective agent root: the first of `<home>`, `<home>/workspace`,
 * `<home>/workspace.default` that contains any recognizable persona file or a
 * `memory/` dir. Falls back to `<home>` if none match (so missing-home behavior
 * is preserved - an empty source, not a throw).
 */
function resolveAgentRoot(home: string): string {
  const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "MEMORY.md", "memory.md"];
  for (const sub of HOME_SUBROOTS) {
    const root = sub ? path.join(home, sub) : home;
    const hasPersona = PERSONA_FILES.some((f) => {
      try {
        return fs.statSync(path.join(root, f)).isFile();
      } catch {
        return false;
      }
    });
    let hasMemoryDir = false;
    try {
      hasMemoryDir = fs.statSync(path.join(root, "memory")).isDirectory();
    } catch {
      hasMemoryDir = false;
    }
    if (hasPersona || hasMemoryDir) return root;
  }
  return home;
}

/**
 * Resolve curated root-memory: canonical "MEMORY.md" first, then legacy
 * lowercase "memory.md". Returns the text + which filename matched.
 */
function readCuratedMemory(root: string): { text?: string; file?: string } {
  for (const name of ROOT_MEMORY_CANDIDATES) {
    const text = readIfPresent(path.join(root, name));
    if (text !== undefined) return { text, file: name };
  }
  return {};
}

/** Resolve the awareness file: prefer "<agentId>-awareness.md", else any "*-awareness.md". */
function findAwareness(memoryDir: string, agentId: string): string | undefined {
  const preferred = path.join(memoryDir, `${agentId}-awareness.md`);
  const direct = readIfPresent(preferred);
  if (direct !== undefined) return direct;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(memoryDir);
  } catch {
    return undefined;
  }
  const match = entries.find((f) => f.endsWith("-awareness.md"));
  return match ? readIfPresent(path.join(memoryDir, match)) : undefined;
}

/** Detect *.sqlite memory stores in a memory dir (newer/builder layout). */
function detectSqliteStores(memoryDir: string): OcSqliteStore[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(memoryDir);
  } catch {
    return [];
  }
  const out: OcSqliteStore[] = [];
  for (const f of entries) {
    if (!f.endsWith(".sqlite")) continue;
    const full = path.join(memoryDir, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ file: full, name: f.replace(/\.sqlite$/, ""), bytes: st.size });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Best-effort read of a sqlite memory store's prose via the node:sqlite builtin
 * (Node >=22.5, experimental). Reconstructs per-file markdown by concatenating
 * `chunks.text` ordered by (path, start_line), de-duplicating exact repeats.
 * Returns daily logs + named memory parsed the same way as the markdown path.
 *
 * If node:sqlite is unavailable OR the db isn't the expected shape, returns
 * null so the caller falls back to DETECT+WARN (no silent empty, no heavy dep).
 */
function readSqliteMemory(
  store: OcSqliteStore,
): {
  dailyLogs: OcDailyLog[];
  namedMemory: OcNamedMemory[];
  awareness?: string;
} | null {
  // node:sqlite is a builtin but experimental; guard the require.
  let DatabaseSync: unknown;
  try {
    DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync?: unknown })
      .DatabaseSync;
  } catch {
    return null;
  }
  if (typeof DatabaseSync !== "function") return null;

  type Row = { path: string; start_line: number; text: string };
  let rows: Row[] = [];
  try {
    const Ctor = DatabaseSync as new (
      p: string,
      o?: { readOnly?: boolean },
    ) => {
      prepare(sql: string): { all(): unknown[] };
      close(): void;
    };
    const db = new Ctor(store.file, { readOnly: true });
    try {
      rows = db
        .prepare(
          "SELECT path, start_line, text FROM chunks ORDER BY path, start_line",
        )
        .all() as Row[];
    } finally {
      db.close();
    }
  } catch {
    // Table missing / locked / not the expected shape: let caller warn.
    return null;
  }

  // Group chunk text by source path, de-dup exact repeats, reassemble prose.
  const byPath = new Map<string, { lines: Set<number>; parts: string[] }>();
  for (const r of rows) {
    if (!r || typeof r.path !== "string" || typeof r.text !== "string") continue;
    let g = byPath.get(r.path);
    if (!g) {
      g = { lines: new Set<number>(), parts: [] };
      byPath.set(r.path, g);
    }
    const ln = Number(r.start_line) || 0;
    if (g.lines.has(ln)) continue; // skip duplicate chunk at same start_line
    g.lines.add(ln);
    g.parts.push(r.text);
  }

  const dailyLogs: OcDailyLog[] = [];
  const namedMemory: OcNamedMemory[] = [];
  // Live open-thread/relationship state lives in <persona>-awareness.md. When a
  // sqlite store carries it, promote it to `awareness` so tierMemories seeds it
  // as CURRENT instead of dropping it as generic named memory.
  let awareness: string | undefined;
  for (const [p, g] of byPath) {
    const base = path.basename(p);
    const text = g.parts.join("\n");
    const m = DAILY_RE.exec(base);
    if (m) {
      const [, y, mo, d] = m;
      const epochMs = Date.UTC(Number(y), Number(mo) - 1, Number(d));
      dailyLogs.push({
        date: `${y}-${mo}-${d}`,
        epochMs: Number.isNaN(epochMs) ? 0 : epochMs,
        filename: base,
        text,
      });
    } else if (base.endsWith("-awareness.md")) {
      // First awareness file wins (the markdown reader prefers <agentId> too).
      if (awareness === undefined) awareness = text;
    } else if (base.endsWith(".md")) {
      namedMemory.push({ key: base.replace(/\.md$/, ""), filename: base, text });
    }
  }
  dailyLogs.sort((a, b) => b.epochMs - a.epochMs);
  namedMemory.sort((a, b) => a.key.localeCompare(b.key));
  return { dailyLogs, namedMemory, awareness };
}

/**
 * Read + classify an OpenClaw agent home. Tolerant of missing files.
 *
 * @param home    Path to the agent home (e.g. ~/.moltbot).
 * @param agentId Agent slug used to resolve the awareness file + tagging.
 */
export function readOcAgentHome(home: string, agentId: string): OcAgentSource {
  // Tolerate flat AND nested (workspace/, workspace.default/) home layouts.
  const resolvedHome = resolveAgentRoot(path.resolve(home));
  const memoryDir = path.join(resolvedHome, "memory");

  const dailyLogs: OcDailyLog[] = [];
  const namedMemory: OcNamedMemory[] = [];
  const warnings: string[] = [];

  let memoryEntries: string[] = [];
  try {
    memoryEntries = fs.readdirSync(memoryDir);
  } catch {
    memoryEntries = [];
  }

  for (const filename of memoryEntries) {
    if (!filename.endsWith(".md")) continue;
    const full = path.join(memoryDir, filename);
    let text: string;
    try {
      if (!fs.statSync(full).isFile()) continue;
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const m = DAILY_RE.exec(filename);
    if (m) {
      const [, y, mo, d] = m;
      const epochMs = Date.UTC(Number(y), Number(mo) - 1, Number(d));
      dailyLogs.push({
        date: `${y}-${mo}-${d}`,
        epochMs: Number.isNaN(epochMs) ? 0 : epochMs,
        filename,
        text,
      });
    } else {
      namedMemory.push({
        key: filename.replace(/\.md$/, ""),
        filename,
        text,
      });
    }
  }

  // ---- sqlite memory (newer/builder layout) ----
  const sqliteStores = detectSqliteStores(memoryDir);
  let sqliteUningested = false;
  let sqliteAwareness: string | undefined;
  if (sqliteStores.length > 0) {
    // Prefer a store matching the agentId slug; else ingest all detected.
    const targeted = sqliteStores.filter((s) => s.name === agentId);
    const toRead = targeted.length > 0 ? targeted : sqliteStores;
    let ingestedAny = false;
    const ingestedStores: string[] = [];
    const failedStores: string[] = [];
    for (const store of toRead) {
      const got = readSqliteMemory(store);
      if (got) {
        ingestedAny = true;
        ingestedStores.push(store.name);
        dailyLogs.push(...got.dailyLogs);
        namedMemory.push(...got.namedMemory);
        // First awareness recovered from sqlite (used only if no markdown one).
        if (sqliteAwareness === undefined && got.awareness !== undefined) {
          sqliteAwareness = got.awareness;
        }
      } else {
        failedStores.push(store.name);
      }
    }
    if (ingestedAny) {
      warnings.push(
        `Read sqlite memory (best-effort) from ${ingestedStores
          .map((n) => `${n}.sqlite`)
          .join(", ")}. Recovered prose is reversed from a vector index; ` +
          `chunk boundaries may differ slightly from the original files.`,
      );
      // A store that failed to read while others succeeded must NOT be hidden by
      // the success message: its memory was dropped, so surface it explicitly.
      if (failedStores.length > 0) {
        warnings.push(
          `WARNING: ${failedStores.length} sqlite store(s) [${failedStores.join(
            ", ",
          )}] could NOT be read (unexpected schema, locked, or node:sqlite ` +
            `unavailable) and were NOT ported. Re-run on Node >=22.5 or export ` +
            `that memory to markdown first.`,
        );
      }
    } else {
      sqliteUningested = true;
      warnings.push(
        `DETECTED ${sqliteStores.length} sqlite memory store(s) [${sqliteStores
          .map((s) => s.name)
          .join(", ")}] but could NOT read them (node:sqlite unavailable in this ` +
          `runtime). Memory was NOT ported. Persona migrated; re-run on Node >=22.5 ` +
          `to ingest sqlite memory, or export memory to markdown first.`,
      );
    }
  }

  // Newest-first so tiering can take the last-N-days off the front.
  dailyLogs.sort((a, b) => b.epochMs - a.epochMs);
  namedMemory.sort((a, b) => a.key.localeCompare(b.key));

  let hasSecretsDir = false;
  try {
    hasSecretsDir = fs
      .statSync(path.join(resolvedHome, "secrets"))
      .isDirectory();
  } catch {
    hasSecretsDir = false;
  }

  const curated = readCuratedMemory(resolvedHome);

  const soul = readIfPresent(path.join(resolvedHome, "SOUL.md"));
  const identity = readIfPresent(path.join(resolvedHome, "IDENTITY.md"));

  // Warn if a home yields neither persona nor memory (e.g. a device/builder
  // home whose identity/ dir is auth, not a character) so we never imply success.
  if (!soul && !identity && dailyLogs.length === 0 && namedMemory.length === 0 && !curated.text) {
    warnings.push(
      `No persona (SOUL/IDENTITY) and no markdown/sqlite memory found under ${resolvedHome}. ` +
        `This may be a device/builder home (identity/ holds auth, not a character). ` +
        `Point --from at a persona home and --agent-id at a real store.`,
    );
  }

  return {
    agentId,
    home: resolvedHome,
    soul,
    identity,
    agents: readIfPresent(path.join(resolvedHome, "AGENTS.md")),
    user: readIfPresent(path.join(resolvedHome, "USER.md")),
    tools: readIfPresent(path.join(resolvedHome, "TOOLS.md")),
    curatedMemory: curated.text,
    curatedMemoryFile: curated.file,
    hbSignal: readIfPresent(path.join(resolvedHome, "HEARTBEAT.md")),
    awareness: findAwareness(memoryDir, agentId) ?? sqliteAwareness,
    dailyLogs,
    namedMemory,
    hasSecretsDir,
    sqliteStores,
    sqliteUningested,
    warnings,
  };
}

/** Named-memory keys treated as the agent's own journal / "becoming" (tier SELF). */
export const SELF_MEMORY_KEYS = [
  "thoughts",
  "inner-state",
  "inner",
  "letter-to-future-self",
  "journal",
  "becoming",
];

/** Named-memory keys treated as HOW/WHERE-to-talk playbooks (→ style.chat / routing). */
export const PLAYBOOK_MEMORY_KEYS = ["conversation-playbook", "channel-guide"];

/** Does a named-memory key look like the agent's own journal? */
export function isSelfMemory(key: string): boolean {
  const k = key.toLowerCase();
  return SELF_MEMORY_KEYS.some((s) => k.includes(s));
}

/** Does a named-memory key look like a talk playbook? */
export function isPlaybookMemory(key: string): boolean {
  const k = key.toLowerCase();
  return PLAYBOOK_MEMORY_KEYS.some((s) => k.includes(s));
}
