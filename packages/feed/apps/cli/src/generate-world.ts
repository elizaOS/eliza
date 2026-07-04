#!/usr/bin/env bun

/**
 * CLI wrapper over the engine's `GameWorld` narrative generator: simulates a
 * day-by-day timeline (default 30 days) of NPC actions, conversations, news,
 * rumors, clues, and feed posts that lead to a predetermined market outcome
 * (YES/NO). Emits typed lifecycle events (`world:started`, `day:begins`,
 * `npc:action`, `outcome:revealed`, …) for verbose logging and can export the
 * result as JSON. Flags: `--outcome`, `--verbose`, `--save=<file>`, `--json`.
 */

import { writeFile } from "node:fs/promises";
import { GameWorld } from "@feed/engine";
import { logger } from "./lib/logger.js";

/**
 * Command-line options for world generation
 * @interface CLIOptions
 * @property {'SUCCESS' | 'FAILURE'} [outcome] - Predetermined world outcome
 * @property {string} [save] - File path to save world JSON
 * @property {boolean} [verbose] - Enable detailed event logging
 * @property {boolean} [json] - Output JSON only (no logs)
 */
interface CLIOptions {
  outcome?: "SUCCESS" | "FAILURE";
  save?: string;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Parses command-line arguments into typed options
 *
 * **Supported Arguments:**
 * - `--outcome=SUCCESS` or `--outcome=FAILURE` - Set predetermined outcome
 * - `--save=filename.json` - Save world to JSON file
 * - `--verbose` or `-v` - Enable verbose logging
 * - `--json` - Output JSON only (for piping to other tools)
 *
 * @returns {CLIOptions} Parsed command-line options
 * @example
 * ```typescript
 * // Called internally with:
 * // bun run generate-world.ts --outcome=SUCCESS --verbose
 * const options = parseArgs();
 * // { outcome: 'SUCCESS', verbose: true }
 * ```
 */
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {};

  args.forEach((arg) => {
    if (arg.startsWith("--outcome=")) {
      options.outcome = arg.split("=")[1] as "SUCCESS" | "FAILURE";
    } else if (arg.startsWith("--save=")) {
      options.save = arg.split("=")[1];
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  });

  return options;
}

/**
 * Main execution function for world generation CLI
 *
 * Creates a complete game world narrative with:
 * 1. Question/scenario setup
 * 2. NPC cast (default: 8 NPCs)
 * 3. 30-day timeline simulation
 * 4. Event-driven narrative generation
 * 5. Social media feed generation
 * 6. Outcome revelation
 *
 * **Verbosity Levels:**
 * - Normal: Basic progress indicators
 * - Verbose: All events, actions, and posts
 * - JSON: Raw output only (no logs)
 *
 * **Output Modes:**
 * - Console: Formatted narrative logs
 * - JSON: Machine-readable world data
 * - File: Saved JSON for later use
 *
 * @throws {Error} Exits with code 1 if world generation fails
 * @returns {Promise<void>} Exits with code 0 on success
 * @example
 * ```bash
 * # Generate and watch narrative unfold
 * bun run src/cli/generate-world.ts --verbose
 *
 * # Output:
 * # GENERATING FEED GAME WORLD
 * # =================================
 * # Question: Will the AI regulation bill pass?
 * # True Outcome: SUCCESS
 * # NPCs in world: 8
 * # --- TIMELINE ---
 * # DAY 1
 * # ──────────────────────────────────────────────
 * # Senator Smith: Announces support for AI bill
 * # Tech CEO Jones: Posts skepticism on social media
 * # ...
 * # ================================================
 * # FINAL OUTCOME: SUCCESS
 * # ================================================
 * # World generation complete
 * # { totalEvents: 450, npcs: 8, daysSimulated: 30 }
 * ```
 */
async function main() {
  const options = parseArgs();

  const outcomeValue = options.outcome !== "FAILURE";

  const world = new GameWorld({
    outcome: outcomeValue,
    numNPCs: 8,
    duration: 30,
    verbosity: options.verbose ? "detailed" : "normal",
  });

  if (options.verbose && !options.json) {
    logger.info("GENERATING FEED GAME WORLD");
    logger.info("=================================");

    world.on("world:started", (event) => {
      logger.info(`Question: ${event.data.question}`);
      logger.info(`True Outcome: ${outcomeValue ? "SUCCESS" : "FAILURE"}`);
      logger.info(`NPCs in world: ${event.data.npcs}`);
      logger.info("--- TIMELINE ---");
    });

    world.on("day:begins", (event) => {
      logger.info(`DAY ${event.data.day}`);
      logger.info("─".repeat(50));
    });

    world.on("npc:action", (event) => {
      logger.info(`${event.npc}: ${event.description}`);
    });

    world.on("npc:conversation", (event) => {
      logger.info(event.description);
    });

    world.on("news:published", (event) => {
      logger.info(`${event.npc}: ${event.description}`);
    });

    world.on("rumor:spread", (event) => {
      logger.info(`Rumor: ${event.description}`);
    });

    world.on("clue:revealed", (event) => {
      logger.info(`${event.npc}: ${event.description}`);
    });

    world.on("development:occurred", (event) => {
      logger.info(`DEVELOPMENT: ${event.description}`);
    });

    world.on("feed:post", (post) => {
      const emoji =
        post.type === "news"
          ? "📰"
          : post.type === "reaction"
            ? "💬"
            : post.type === "thread"
              ? "🧵"
              : "📢";

      const prefix = post.replyTo ? "    ↳" : "  ";
      logger.info(`${prefix}${emoji} ${post.author}: ${post.content}`);

      if (post.clueStrength > 0.5) {
        logger.debug(
          `${prefix}   [Strong clue: ${post.clueStrength.toFixed(1)}]`,
        );
      }
    });

    world.on("outcome:revealed", (event) => {
      logger.info("=".repeat(50));
      logger.info(
        `FINAL OUTCOME: ${event.data.outcome ? "SUCCESS" : "FAILURE"}`,
      );
      logger.info("=".repeat(50));
    });
  }

  const finalWorld = await world.generate();

  if (options.save) {
    const json = JSON.stringify(finalWorld, null, 2);
    await writeFile(options.save, json);

    if (!options.json) {
      logger.info(`World saved to: ${options.save}`);
    }
  }

  if (!options.json) {
    logger.info("World generation complete", {
      totalEvents: finalWorld.events.length,
      npcs: finalWorld.npcs.length,
      daysSimulated: finalWorld.timeline.length,
      finalOutcome: finalWorld.outcome ? "SUCCESS" : "FAILURE",
    });
  } else {
    logger.info(JSON.stringify(finalWorld, null, 2));
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Error:", error);
    process.exit(1);
  });
}

export { main };
