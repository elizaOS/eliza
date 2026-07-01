/**
 * OpenClaw memory → Eliza `Memory[]`, recency-tiered.
 *
 * The key design (proven on Sol): seed RECENCY-AWARE so stale threads don't
 * resurface as live. Tiers:
 *   T1 CURRENT  - <agent>-awareness.md + last N days of daily logs → verbatim
 *   T2 LONGTERM - MEMORY.md → chunked by markdown section
 *   T3 SELF     - journal/inner-state/letter files → verbatim (the becoming)
 *   T4 OLDER    - older daily logs NOT flat-seeded; one summary marker instead
 *
 * Embeddings are NOT computed here - the Eliza runtime adds them at import/seed
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
   * When true, the personal corpus (daily logs, awareness, curated MEMORY.md,
   * SELF journals) is NOT seeded into the result; a single marker is seeded
   * instead. Portable .eliza-agent archives default this on so a shareable
   * archive cannot leak personal context (#10283); the sovereign-local path
   * passes false to seed the full corpus on the owner's own machine. The
   * firewall posture is decided one level up, from the same flag the character
   * mapper firewalls USER.md with.
   */
  firewall?: boolean;
}

export interface TieringResult {
  memories: Memory[];
  counts: Record<MemoryTier, number>;
  /** How many memories were dropped as cross-tier duplicates. */
  duplicatesDropped: number;
  /** How many memory bodies were clipped at maxChunkLen (content lost). */
  clipped: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tier seed-priority for dedup: keep the highest-priority copy of a fact. */
const TIER_PRIORITY: Record<MemoryTier, number> = {
  CURRENT: 3,
  SELF: 2,
  LONGTERM: 1,
  MARKER: 0,
};

/** Collapse whitespace for duplicate detection (mirrors Hermes normalize_text). */
function normalizeForDedup(text: string): string {
  // Drop the leading "[TIER] " tag so the same fact in two tiers collides.
  return text
    .replace(/^\[[A-Z]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Mutable counter passed through mkMemory so we can tally clips. */
interface ClipCounter {
  n: number;
}

function mkMemory(
  text: string,
  tier: MemoryTier,
  opts: TieringOptions,
  createdAt: number,
  clipCounter?: ClipCounter,
): Memory {
  const max = opts.maxChunkLen ?? 6000;
  const wasClipped = text.length > max;
  if (wasClipped && clipCounter) clipCounter.n++;
  const body = wasClipped ? text.slice(0, max) : text;
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
  const clip: ClipCounter = { n: 0 };

  // ---- FIREWALL: a portable archive carries the persona, NOT the personal corpus ----
  // Daily logs, <agent>-awareness.md, curated MEMORY.md, and SELF journals all
  // describe the owner / private life. With the firewall on we seed NONE of them
  // -- only a marker -- so a shared archive cannot leak personal context (#10283).
  // The sovereign-local path passes firewall=false to seed the full corpus.
  if (firewall) {
    memories.push(
      mkMemory(
        "Personal memory (daily logs, journals, awareness, and curated long-term " +
          "memory) was firewalled out of this portable archive for privacy. Re-seed " +
          "it from a sovereign-local export on the owner's own machine if you need it.",
        "MARKER",
        opts,
        now,
        clip,
      ),
    );
    counts.MARKER++;
    return { memories, counts, duplicatesDropped: 0, clipped: clip.n };
  }

  // ---- T1 CURRENT: awareness (highest signal) + last-N-day daily logs ----
  if (src.awareness?.trim()) {
    memories.push(mkMemory(src.awareness.trim(), "CURRENT", opts, now, clip));
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
            clip,
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
      memories.push(mkMemory(chunk, "LONGTERM", opts, now - 1, clip));
      counts.LONGTERM++;
    }
  }

  // ---- T3 SELF: the agent's own journal/becoming files, verbatim ----
  for (const m of src.namedMemory) {
    if (!isSelfMemory(m.key)) continue;
    if (m.text.trim().length < minLen) continue;
    memories.push(
      mkMemory(`${m.key}\n${m.text.trim()}`, "SELF", opts, now - 2, clip),
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

  // ---- Cross-tier dedup: the same fact can appear in MEMORY.md AND a daily log
  // AND a journal. Keep the highest-priority-tier copy; drop the rest. (Mirrors
  // Hermes's normalize_text + seen-set dedup, but tier-priority-aware.) ----
  const { deduped, duplicatesDropped } = dedupeByTierPriority(memories, counts);

  return { memories: deduped, counts, duplicatesDropped, clipped: clip.n };
}

/**
 * Drop cross-tier duplicate memories (by normalized text), keeping the
 * highest-priority tier's copy. Decrements `counts` for dropped entries so the
 * reported tier counts stay accurate. Order-stable for the survivors.
 */
function dedupeByTierPriority(
  memories: Memory[],
  counts: Record<MemoryTier, number>,
): { deduped: Memory[]; duplicatesDropped: number } {
  // First pass: for each normalized body, find the winning (highest-priority) id.
  const winnerByKey = new Map<string, { id: string; prio: number }>();
  for (const m of memories) {
    const key = normalizeForDedup(m.content.text);
    if (!key) continue;
    const prio = TIER_PRIORITY[m.metadata.tier as MemoryTier] ?? 0;
    const cur = winnerByKey.get(key);
    if (!cur || prio > cur.prio) winnerByKey.set(key, { id: m.id, prio });
  }
  // Second pass: keep only the winner for each key (and any keyless memory).
  const deduped: Memory[] = [];
  let duplicatesDropped = 0;
  const kept = new Set<string>();
  for (const m of memories) {
    const key = normalizeForDedup(m.content.text);
    if (!key) {
      deduped.push(m);
      continue;
    }
    const winner = winnerByKey.get(key);
    if (winner && winner.id === m.id && !kept.has(key)) {
      deduped.push(m);
      kept.add(key);
    } else {
      duplicatesDropped++;
      const tier = m.metadata.tier as MemoryTier;
      if (counts[tier] > 0) counts[tier]--;
    }
  }
  return { deduped, duplicatesDropped };
}
