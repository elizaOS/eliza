/**
 * `babylon tick` — Execute a single game tick (or loop).
 */

import { resolve } from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import { loadBabylonConfig } from "../../core/config";
import { buildEngine, parseInterval } from "../shared";

export default defineCommand({
  meta: {
    name: "tick",
    description: "Execute a single game tick (or loop with --loop)",
  },
  args: {
    rootDir: {
      type: "string",
      description: "Project root directory",
      default: ".",
    },
    loop: {
      type: "boolean",
      description: "Run continuously in a loop",
      default: false,
    },
    interval: {
      type: "string",
      description: "Seconds between ticks (only with --loop)",
      default: "60",
    },
    legacy: {
      type: "boolean",
      description: "Include legacy game-tick bridge system",
      default: false,
    },
  },
  async run({ args }) {
    const rootDir = resolve(args.rootDir);
    const { config, configFile } = await loadBabylonConfig(rootDir);
    consola.info(`Config: ${configFile ?? "defaults"}`);

    const engine = await buildEngine(config, rootDir, args.legacy);

    if (!args.loop) {
      consola.start("Executing single tick...");
      const start = Date.now();
      try {
        const metrics = await engine.tick();
        const ms = Date.now() - start;
        consola.success(`Tick completed in ${ms}ms`, metrics);
      } catch (err) {
        consola.error("Tick failed:", err);
      }
      await engine.shutdown();
      return;
    }

    // Loop mode
    const intervalSec = parseInterval(args.interval, "interval");
    consola.box(`Babylon Runtime — tick loop (${intervalSec}s interval)`);

    let running = true;
    let tickCount = 0;

    const cleanup = async () => {
      if (!running) return;
      running = false;
      consola.info("Shutting down...");
      await engine.shutdown();
      consola.success(`Stopped after ${tickCount} ticks`);
      process.exit(0);
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);

    while (running) {
      tickCount++;
      consola.start(`Tick #${tickCount}`);
      const start = Date.now();
      try {
        await engine.tick();
        const ms = Date.now() - start;
        consola.success(`Tick #${tickCount} completed in ${ms}ms`);
      } catch (err) {
        consola.error(`Tick #${tickCount} failed:`, err);
      }

      if (running) {
        consola.info(`Next tick in ${intervalSec}s...`);
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
    }
  },
});
