/**
 * OpenClaw memory → Eliza `Memory[]`, recency-tiered.
 *
 * The key design (proven on Sol): seed RECENCY-AWARE so stale threads don't
 * resurface as live. Tiers:
 *   T1 CURRENT  — <agent>-awareness.md + last N days of daily logs → verbatim
 *   T2 LONGTERM — MEMORY.md → chunked by markdown section
 *   T3 SELF     — journal/inner-state/letter files → verbatim (the becoming)
 *   T4 OLDER    — older daily logs NOT flat-seeded; one summary marker instead
 *
 * Embeddings are NOT computed here — the Eliza runtime adds them at import/seed
 * time. Each Memory is content-only with a tier tag in metadata + a text prefix.
 */

import { randomUUID } from "node:crypto";
import { isSelfMemory, type OcAgentSource } from "./openclaw-reader.js";
import type { MigratedMemory as Memory, UUID } from "./types.js";

export type MemoryTier = "CURRENT" | "LONGTERM" | "SELF" | "MARKER";

export interface TieringOptions {
  /** How many days of daily logs to seed verbatim as CURRENT. Default 14. */
  memoryDays: number;
  /** Room all migrated memories attach to. */
  roomId: UUID;
  /** Entity (the agent) the memories belong to. */
  entityId: UUID;
  /** Agent id (for the agentId field + tagging). */
  agentId: UUID;
  /** Minimum chunk length to bother seeding. Default 20 chars. */
  minChunkLen?: number;
  /** Max chars per memory (longer chunks are clipped). Default 6000. */
  maxChunkLen?: number;
  /**
   * When true (the posture `buildMigrationPlan` uses for a PORTABLE archive),
   * the personal memory corpus is EXCLUDED: daily logs, `<agent>-awareness.md`,
   * curated `MEMORY.md`, and the agent's own SELF journals all describe the
   * owner / private life and must never leak off the owner's machine. Only a
   * marker noting the exclusion is seeded. The sovereign-local path passes
   * `false` to seed the full corpus on the owner's own machine. Default `false`
   * (callers opt in — the firewall posture is decided one level up, from the
   * same flag the character mapper firewalls USER.md with).
   */
  firewall?: boolean;
}

export interface TieringResult {
  memories: Memory[];
  counts: Record<MemoryTier, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function mkMemory(
  text: string,
  tier: MemoryTier,
  opts: TieringOptions,
  createdAt: number,
): Memory {
  const max = opts.maxChunkLen ?? 6000;
  const body = text.length > max ? text.slice(0, max) : text;
  return {
    id: randomUUID() as UUID,
    entityId: opts.entityId,
    agentId: opts.agentId,
    roomId: opts.roomId,
    createdAt,
    content: { text: `[${tier}] ${body}` },
    metadata: {
      type: "custom",
      // Provenance for downstream filtering / debugging.
      source: "openclaw-migration",
      tier,
    } as Memory["metadata"],
    unique: true,
  };
}

/** Split a markdown doc into section chunks by top-level "## " / "# " headings. */
function chunkBySection(md: string, minLen: number): string[] {
  const lines = md.split("\n");
  const chunks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t.length >= minLen) chunks.push(t);
    buf = [];
  };
  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line) && buf.length) flush();
    buf.push(line);
  }
  flush();
  return chunks;
}

/**
 * Produce tiered Eliza memories from an OpenClaw source.
 */
export function tierMemories(
  src: OcAgentSource,
  opts: TieringOptions,
): TieringResult {
  const firewall = opts.firewall ?? false;
  const minLen = opts.minChunkLen ?? 20;
  const memories: Memory[] = [];
  const counts: Record<MemoryTier, number> = {
    CURRENT: 0,
    LONGTERM: 0,
    SELF: 0,
    MARKER: 0,
  };
  const now = Date.now();
  const cutoff = now - opts.memoryDays * DAY_MS;

  // ---- FIREWALL: a portable archive carries the persona, NOT the personal corpus ----
  // Daily logs, <agent>-awareness.md, curated MEMORY.md, and SELF journals all
  // describe the owner / private life. With the firewall on we seed NONE of them
  // — only a marker — so a shared archive cannot leak personal context. The
  // sovereign-local path passes firewall=false to seed the full corpus.
  if (firewall) {
    memories.push(
      mkMemory(
        "Personal memory (daily logs, journals, awareness, and curated long-term " +
          "memory) was firewalled out of this portable archive for privacy. Re-seed " +
          "it from a sovereign-local export on the owner's own machine if you need it.",
        "MARKER",
        opts,
        now,
      ),
    );
    counts.MARKER++;
    return { memories, counts };
  }

  // ---- T1 CURRENT: awareness (highest signal) + last-N-day daily logs ----
  if (src.awareness?.trim()) {
    memories.push(mkMemory(src.awareness.trim(), "CURRENT", opts, now));
    counts.CURRENT++;
  }
  let olderCount = 0;
  for (const log of src.dailyLogs) {
    const ts = log.epochMs || 0;
    if (ts >= cutoff) {
      if (log.text.trim().length >= minLen) {
        memories.push(
          mkMemory(
            `daily log ${log.date ?? log.filename}\n${log.text.trim()}`,
            "CURRENT",
            opts,
            ts || now,
          ),
        );
        counts.CURRENT++;
      }
    } else {
      olderCount++;
    }
  }

  // ---- T2 LONGTERM: curated MEMORY.md, chunked by section ----
  if (src.curatedMemory?.trim()) {
    for (const chunk of chunkBySection(src.curatedMemory, minLen)) {
      memories.push(mkMemory(chunk, "LONGTERM", opts, now - 1));
      counts.LONGTERM++;
    }
  }

  // ---- T3 SELF: the agent's own journal/becoming files, verbatim ----
  for (const m of src.namedMemory) {
    if (!isSelfMemory(m.key)) continue;
    if (m.text.trim().length < minLen) continue;
    memories.push(
      mkMemory(`${m.key}\n${m.text.trim()}`, "SELF", opts, now - 2),
    );
    counts.SELF++;
  }

  // ---- T4 OLDER: NOT flat-seeded. One marker so the agent knows history exists. ----
  if (olderCount > 0) {
    const oldest = src.dailyLogs[src.dailyLogs.length - 1]?.date ?? "earlier";
    memories.push(
      mkMemory(
        `Older history (${olderCount} daily logs before the last ${opts.memoryDays} days, ` +
          `back to ${oldest}) is summarized and NOT seeded verbatim to avoid resurfacing ` +
          `stale threads. Ask the owner if you need detail from a specific older date.`,
        "MARKER",
        opts,
        cutoff - 1,
      ),
    );
    counts.MARKER++;
  }

  return { memories, counts };
}
