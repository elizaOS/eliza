/**
 * OpenClaw agent-home reader.
 *
 * Reads a file-based OCPlatform ("moltbot") agent home and classifies its
 * contents into a typed source object the migration pipeline consumes. Pure
 * filesystem + classification: NO network, NO side effects. Missing files are
 * tolerated (returned as undefined / empty) so partial homes still migrate.
 *
 * An OpenClaw home looks like:
 *   <home>/SOUL.md IDENTITY.md AGENTS.md USER.md TOOLS.md   (persona + ops)
 *   <home>/MEMORY.md HB_SIGNAL.md                            (curated memory + hb)
 *   <home>/<agent>-awareness.md                              (live open-threads)
 *   <home>/memory/YYYY-MM-DD.md                              (daily logs)
 *   <home>/memory/<named>.md                                 (journals, playbooks, etc)
 *   <home>/secrets/                                          (keys — firewalled, never read here)
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

export interface OcAgentSource {
  agentId: string;
  home: string;
  /** SOUL.md — core voice/values. */
  soul?: string;
  /** IDENTITY.md — name/vibe/appearance/personality. */
  identity?: string;
  /** AGENTS.md — behavioral + ops rules. */
  agents?: string;
  /** USER.md — about the human. FIREWALLED (personal). */
  user?: string;
  /** TOOLS.md — infra/keys/notes → plugin config, NOT persona. */
  tools?: string;
  /** MEMORY.md — curated long-term memory. */
  curatedMemory?: string;
  /** HEARTBEAT.md — heartbeat checklist. */
  hbSignal?: string;
  /** <agent>-awareness.md — live open-threads / relationship state. */
  awareness?: string;
  /** memory/YYYY-MM-DD.md — daily logs, sorted newest-first. */
  dailyLogs: OcDailyLog[];
  /**
   * memory/<named>.md — non-daily memory files (journals, playbooks, channel
   * guides, project/routine docs). Keyed by basename.
   */
  namedMemory: OcNamedMemory[];
  /** Whether a secrets/ dir exists (contents intentionally NOT read). */
  hasSecretsDir: boolean;
}

const DAILY_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

function readIfPresent(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
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

/**
 * Read + classify an OpenClaw agent home. Tolerant of missing files.
 *
 * @param home    Path to the agent home (e.g. ~/.moltbot).
 * @param agentId Agent slug used to resolve the awareness file + tagging.
 */
export function readOcAgentHome(home: string, agentId: string): OcAgentSource {
  const resolvedHome = path.resolve(home);
  const memoryDir = path.join(resolvedHome, "memory");

  const dailyLogs: OcDailyLog[] = [];
  const namedMemory: OcNamedMemory[] = [];

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

  // Newest-first so tiering can take the last-N-days off the front.
  dailyLogs.sort((a, b) => b.epochMs - a.epochMs);
  namedMemory.sort((a, b) => a.key.localeCompare(b.key));

  let hasSecretsDir = false;
  try {
    hasSecretsDir = fs.statSync(path.join(resolvedHome, "secrets")).isDirectory();
  } catch {
    hasSecretsDir = false;
  }

  return {
    agentId,
    home: resolvedHome,
    soul: readIfPresent(path.join(resolvedHome, "SOUL.md")),
    identity: readIfPresent(path.join(resolvedHome, "IDENTITY.md")),
    agents: readIfPresent(path.join(resolvedHome, "AGENTS.md")),
    user: readIfPresent(path.join(resolvedHome, "USER.md")),
    tools: readIfPresent(path.join(resolvedHome, "TOOLS.md")),
    curatedMemory: readIfPresent(path.join(resolvedHome, "MEMORY.md")),
    hbSignal: readIfPresent(path.join(resolvedHome, "HEARTBEAT.md")),
    awareness: findAwareness(memoryDir, agentId),
    dailyLogs,
    namedMemory,
    hasSecretsDir,
  };
}

/** Named-memory keys treated as the agent's own journal / "becoming" (tier SELF). */
export const SELF_MEMORY_KEYS = [
  "thoughts",
  "inner-state",
  "letter-to-future-self",
  "journal",
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
