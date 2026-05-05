#!/usr/bin/env bun
/**
 * Babylon Runtime CLI
 *
 * Usage:
 *   babylon dev        Start dev mode with hot-reload
 *   babylon tick       Execute a single tick (or loop with --loop)
 *   babylon build      Bundle for production
 *   babylon info       Show config and discovered systems
 *   babylon document   Generate markdown reference from system metadata
 */

import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "babylon",
    version: "0.1.0",
    description:
      "Babylon Runtime — standalone system engine for the Babylon simulation",
  },
  subCommands: {
    dev: () => import("./commands/dev").then((m) => m.default),
    build: () => import("./commands/build").then((m) => m.default),
    tick: () => import("./commands/tick").then((m) => m.default),
    info: () => import("./commands/info").then((m) => m.default),
    document: () => import("./commands/document").then((m) => m.default),
  },
});

runMain(main);
