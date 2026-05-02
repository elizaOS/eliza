/* ------------------------------------------------------------------ */
/*  2004scape SDK — action helper utilities                            */
/* ------------------------------------------------------------------ */

import type { BotSDK } from "./index.js";
import type {
  BotWorldState,
  GroundItem,
  InventoryItem,
  NearbyLoc,
  NearbyNpc,
  ShopItem,
} from "./types.js";

/* ------------------------------------------------------------------ */
/*  Entity lookup helpers                                              */
/* ------------------------------------------------------------------ */

/** Case-insensitive partial match on NPC name, closest first. */
export function findNpcByName(
  state: BotWorldState,
  name: string,
): NearbyNpc | null {
  const lower = name.toLowerCase();
  const matches = state.nearbyNpcs
    .filter((n) => n.name.toLowerCase().includes(lower))
    .sort((a, b) => a.distance - b.distance);
  return matches[0] ?? null;
}

/** Case-insensitive partial match on loc name, closest first. */
export function findLocByName(
  state: BotWorldState,
  name: string,
): NearbyLoc | null {
  const lower = name.toLowerCase();
  const matches = state.nearbyLocs
    .filter((l) => l.name.toLowerCase().includes(lower))
    .sort((a, b) => a.distance - b.distance);
  return matches[0] ?? null;
}

/** Case-insensitive partial match on inventory item name. */
export function findInventoryItem(
  state: BotWorldState,
  name: string,
): InventoryItem | null {
  const lower = name.toLowerCase();
  return (
    state.inventory.find((i) => i.name.toLowerCase().includes(lower)) ?? null
  );
}

/** Find an inventory item by its numeric id. */
export function findInventoryItemById(
  state: BotWorldState,
  id: number,
): InventoryItem | null {
  return state.inventory.find((i) => i.id === id) ?? null;
}

/** Case-insensitive partial match on ground item name, closest first. */
export function findGroundItemByName(
  state: BotWorldState,
  name: string,
): GroundItem | null {
  const lower = name.toLowerCase();
  const matches = state.groundItems
    .filter((g) => g.name.toLowerCase().includes(lower))
    .sort((a, b) => a.distance - b.distance);
  return matches[0] ?? null;
}

/** Case-insensitive partial match on shop item name. */
export function findShopItemByName(
  state: BotWorldState,
  name: string,
): ShopItem | null {
  if (!state.shop?.isOpen) return null;
  const lower = name.toLowerCase();
  return (
    state.shop.items.find((i) => i.name.toLowerCase().includes(lower)) ?? null
  );
}

/** Case-insensitive partial match on bank item name. */
export function findBankItemByName(
  state: BotWorldState,
  name: string,
): { id: number; name: string; count: number; slot: number } | null {
  if (!state.bank?.isOpen) return null;
  const lower = name.toLowerCase();
  const item = state.bank.items.find((i) =>
    i.name.toLowerCase().includes(lower),
  );
  if (!item) return null;
  return { id: item.id, name: item.name, count: item.count, slot: item.slot };
}

/* ------------------------------------------------------------------ */
/*  Option / index helpers                                             */
/* ------------------------------------------------------------------ */

/** Case-insensitive match on an options array. Returns matching index or 0. */
export function getOptionIndex(options: string[], optionName: string): number {
  const lower = optionName.toLowerCase();
  const idx = options.findIndex((o) => o.toLowerCase() === lower);
  return idx >= 0 ? idx : 0;
}

/* ------------------------------------------------------------------ */
/*  State query helpers                                                */
/* ------------------------------------------------------------------ */

/** Returns true when all 28 inventory slots are occupied. */
export function isInventoryFull(state: BotWorldState): boolean {
  return state.inventory.length >= 28;
}

/** Get current level for a skill by name (case-insensitive). Returns 0 if not found. */
export function getSkillLevel(state: BotWorldState, skillName: string): number {
  const lower = skillName.toLowerCase();
  const skill = state.skills.find((s) => s.name.toLowerCase() === lower);
  return skill?.level ?? 0;
}

/** Chebyshev distance (game-tile distance). */
export function distance(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(z1 - z2));
}

/* ------------------------------------------------------------------ */
/*  Async movement / retry helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * Waits until the player stops moving (animId settles to -1 or stays
 * constant across ticks). Returns true if movement completed, false on
 * timeout.
 */
export async function waitForMovementComplete(
  sdk: BotSDK,
  timeoutMs = 15_000,
): Promise<boolean> {
  try {
    await sdk.waitForState((s) => {
      if (!s.player) return false;
      // animId -1 is the idle pose; treat it as "not moving".
      return s.player.animId === -1;
    }, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry wrapper for actions that may fail because a door is blocking
 * the path. On failure it looks for the nearest door/gate loc and
 * tries to open it before retrying.
 */
export async function withDoorRetry<T>(
  sdk: BotSDK,
  fn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Try opening a nearby door / gate before the next attempt.
      const state = sdk.getState();
      if (!state) continue;
      const door = state.nearbyLocs
        .filter((l) => {
          const n = l.name.toLowerCase();
          return (
            (n.includes("door") || n.includes("gate")) &&
            l.options.some((o) => o.toLowerCase() === "open")
          );
        })
        .sort((a, b) => a.distance - b.distance)[0];

      if (door) {
        const opIdx = getOptionIndex(door.options, "Open");
        try {
          await sdk.sendInteractLoc(door.locId, opIdx);
          await sdk.waitForTicks(3);
        } catch {
          // Swallow — the retry loop handles the next attempt.
        }
      }
    }
  }
  throw lastError;
}

/**
 * Walks a single step toward the target coordinates. Useful for
 * incremental pathfinding or approaching an entity. Returns true if a
 * step was taken, false if already at target.
 */
export async function walkStepToward(
  sdk: BotSDK,
  targetX: number,
  targetZ: number,
  stepSize = 1,
): Promise<boolean> {
  const state = sdk.getState();
  if (!state?.player) return false;

  const dx = targetX - state.player.worldX;
  const dz = targetZ - state.player.worldZ;

  if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) return false; // already adjacent

  const sx = dx === 0 ? 0 : dx > 0 ? stepSize : -stepSize;
  const sz = dz === 0 ? 0 : dz > 0 ? stepSize : -stepSize;

  await sdk.sendWalk(state.player.worldX + sx, state.player.worldZ + sz);
  await sdk.waitForTicks(2);
  return true;
}
