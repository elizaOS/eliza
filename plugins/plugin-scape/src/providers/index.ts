/**
 * Provider registry for `@elizaos/app-scape`.
 *
 * Providers are the "read" side of the game-agent contract — they
 * format pieces of the current perception snapshot into compact JSON
 * blocks that the autonomous loop injects into the LLM prompt. Every
 * snapshot read flows through a provider so:
 *
 *   - The LLM sees a consistent vocabulary across steps.
 *   - Token usage per section is visible and budgetable.
 *   - Adding / removing context is a single-file change.
 *
 * PR 4 ships three providers:
 *
 *   1. `bot-state`   — the agent's own HP, position, combat state
 *   2. `inventory`   — inventory + equipment (empty slots elided)
 *   3. `nearby`      — NPCs / players / ground items / objects in radius
 *
 * PR 5 adds `skills`, `journal`, `goals`, `world-knowledge`.
 */

import type { Provider } from "@elizaos/core";

import { botStateProvider } from "./bot-state.js";
import { goalsProvider } from "./goals.js";
import { inventoryProvider } from "./inventory.js";
import { journalProvider } from "./journal.js";
import { nearbyProvider } from "./nearby.js";

/**
 * PR 6 ships five providers — the three from PR 4 plus the
 * Scape Journal (memories + goals). The loop's `gatherProviderContext`
 * iterates all of these and concatenates the result into the LLM
 * prompt every step.
 */
export const scapeProviders: Provider[] = [
  botStateProvider,
  inventoryProvider,
  nearbyProvider,
  journalProvider,
  goalsProvider,
];
