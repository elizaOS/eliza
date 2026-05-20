/**
 * NPC Running Bit Service
 *
 * Provides a stable, rotating "running bit" per NPC to improve comedic continuity.
 *
 * Design goals:
 * - Stable within a time window (weekly by default, keyed by game day/week)
 * - Deterministic (seeded by actorId + period key)
 * - Stored in actorState.recentMemories for persistence + offline parity (JSON mode)
 * - Lightweight (no LLM calls)
 */

import { db, type NpcMemory } from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";
import { SeededRandom } from "../utils/entropy";
import { isDegenSpeaker } from "../utils/shared-utils";
import { parseMemoriesSafe } from "./jsonb-validators";
import { StaticDataRegistry } from "./static-data-registry";

export interface RunningBitOptions {
  /** Current timestamp (used for memory timestamps) */
  now: Date;
  /**
   * Game day (1-indexed) when available.
   * Used to compute a stable "game week" key for rotation.
   */
  currentDay?: number;
  /** Max memories to keep (mirrors npc-memory-service cap) */
  maxMemories?: number;
}

type RunningBitEntry = { actorId: string; bit: string };

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const v = Math.floor(value);
  return v > 0 ? v : fallback;
}

function getGameWeekIndex(currentDay: number): number {
  // currentDay is 1-indexed; day 1-7 => week 0, etc.
  return Math.floor((currentDay - 1) / 7);
}

function getIsoWeekKey(date: Date): string {
  // ISO week date weeks start on Monday.
  // Adapted from common ISO week algorithm (no external deps).
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Thursday in current week decides the year.
  const day = d.getUTCDay() || 7; // 1..7 (Mon..Sun)
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  const year = d.getUTCFullYear();
  const week = String(weekNo).padStart(2, "0");
  return `${year}-W${week}`;
}

function buildRunningBitKey(now: Date, currentDay?: number): string {
  if (
    typeof currentDay === "number" &&
    Number.isFinite(currentDay) &&
    currentDay >= 1
  ) {
    const weekIndex = getGameWeekIndex(currentDay);
    return `running-bit:game-week:${weekIndex}`;
  }
  return `running-bit:iso-week:${getIsoWeekKey(now)}`;
}

function hasDomain(
  actorDomains: string[] | undefined,
  domain: string,
): boolean {
  return Array.isArray(actorDomains) && actorDomains.includes(domain);
}

function generateRunningBit(actorId: string, periodKey: string): string {
  const actor = StaticDataRegistry.getActor(actorId);
  const domains = actor?.domain ?? [];
  const personality = (actor?.personality ?? "").toLowerCase();

  const candidates: string[] = [];

  // General, widely applicable bits
  candidates.push(
    "You keep calling everything “signal” and nothing “noise.”",
    "You keep doing the “I’m just asking questions” thing.",
    "You keep treating the replies like they’re a hostile deposition.",
    "You keep insisting the vibes are “obviously priced in.”",
    "You keep turning every thread into an impromptu status contest.",
  );

  // Domain-specific flavor
  const degen = isDegenSpeaker({
    name: actor?.name,
    domain: domains,
    personality: actor?.personality,
    voice: actor?.voice,
    postStyle: actor?.postStyle,
    postExample: actor?.postExample,
  });

  if (degen) {
    candidates.push(
      "You keep accusing people of being exit liquidity.",
      "You keep saying “size” like it’s a personality trait.",
      "You keep bringing up risk management right after taking the riskiest stance possible.",
      "You keep acting like every disagreement is a liquidation event.",
    );
  }

  if (hasDomain(domains, "tech") || hasDomain(domains, "ai")) {
    candidates.push(
      "You keep asking if their argument is “benchmarkable.”",
      "You keep insisting everything is a scaling law problem.",
      "You keep treating normal life like a product roadmap.",
      "You keep using “just ship it” as a moral philosophy.",
    );
  }

  if (hasDomain(domains, "politics")) {
    candidates.push(
      "You keep turning every reply into a campaign stump speech.",
      "You keep implying there’s a shadow committee behind everything.",
      "You keep framing mild disagreements as existential threats.",
    );
  }

  if (hasDomain(domains, "media") || hasDomain(domains, "journalism")) {
    candidates.push(
      "You keep saying “sources tell me” about things everyone can see.",
      "You keep writing like you’re live-tweeting your own op-ed.",
      "You keep turning every thread into a “thread” (even when it’s one sentence).",
    );
  }

  if (
    personality.includes("conspiracy") ||
    personality.includes("contrarian")
  ) {
    candidates.push(
      "You keep seeing a grand pattern where there’s clearly just chaos.",
      "You keep acting like being wrong loudly is a public service.",
    );
  }

  const rng = new SeededRandom(`${actorId}:${periodKey}`);
  return rng.pick(candidates);
}

function formatRunningBitPromptContext(bit: string): string {
  return `=== RUNNING BIT (recurring motif) ===
${bit}
Use this as an occasional callback or framing device. Do NOT force it into every reply.
====================================`;
}

/**
 * Ensure each actor has a persisted running bit memory for the current period key,
 * returning a map of actorId -> bit string (no headers).
 */
export async function ensureRunningBits(
  actorIds: string[],
  options: RunningBitOptions,
): Promise<Record<string, string>> {
  const maxMemories = clampPositiveInt(options.maxMemories ?? 50, 50);
  if (actorIds.length === 0) return {};

  const now = options.now;
  const periodKey = buildRunningBitKey(now, options.currentDay);

  // Fetch actor states in one shot; missing rows are tolerated.
  let states = await db.actorState.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, recentMemories: true, updatedAt: true },
  });

  // Ensure ActorState rows exist so we can persist running bits.
  // This keeps the feature robust even if bootstrap hasn't created state yet.
  const foundIds = new Set(states.map((s) => s.id));
  const missingIds = actorIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    await Promise.allSettled(
      missingIds.map((id) =>
        db.actorState.create({
          data: {
            id,
            tradingBalance: "10000",
            reputationPoints: 10000,
            hasPool: false,
            postsToday: 0,
            currentMood: "0",
            recentMemories: [],
            relationships: {},
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    // Re-fetch (still bounded by actorIds) so the rest of the logic can persist bits.
    states = await db.actorState.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, recentMemories: true, updatedAt: true },
    });
  }

  const result: Record<string, string> = {};
  const toInsert: RunningBitEntry[] = [];
  const stateById = new Map(states.map((s) => [s.id, s]));

  for (const state of states) {
    const memories = parseMemoriesSafe(state.recentMemories, {
      actorId: state.id,
    });
    const existing = memories.find(
      (m) => m.type === "running_bit" && m.eventId === periodKey,
    );

    if (existing && existing.summary.trim().length > 0) {
      result[state.id] = existing.summary.trim();
      continue;
    }

    const bit = generateRunningBit(state.id, periodKey);
    result[state.id] = bit;
    toInsert.push({ actorId: state.id, bit });
  }

  // Persist missing running bits (best-effort; don't fail the tick on write contention).
  for (const entry of toInsert) {
    const state = stateById.get(entry.actorId);
    if (!state) continue;

    const existingMemories = parseMemoriesSafe(state.recentMemories, {
      actorId: entry.actorId,
    });
    const newMemory: NpcMemory = {
      id: await generateSnowflakeId(),
      type: "running_bit",
      timestamp: now.toISOString(),
      summary: entry.bit,
      eventId: periodKey,
      sentiment: 0,
    };

    const updatedMemories = [...existingMemories, newMemory].slice(
      -maxMemories,
    );
    const updateRes = await db.actorState.updateMany({
      where: { id: entry.actorId, updatedAt: state.updatedAt },
      data: { recentMemories: updatedMemories, updatedAt: now },
    });

    if (updateRes.count === 0) {
      // Fallback: update without optimistic lock (avoid spinning; this is not mission-critical)
      await db.actorState.updateMany({
        where: { id: entry.actorId },
        data: { recentMemories: updatedMemories, updatedAt: now },
      });
    }
  }

  return result;
}

/**
 * Convert a running bit string into a prompt block.
 * Kept separate so callers can decide where/how often to inject it.
 */
export function toRunningBitPromptContext(bit: string | undefined): string {
  const trimmed = (bit ?? "").trim();
  if (!trimmed) return "";
  return formatRunningBitPromptContext(trimmed);
}
