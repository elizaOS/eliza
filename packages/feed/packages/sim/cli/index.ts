#!/usr/bin/env bun
/**
 * Feed Runtime CLI
 *
 * Usage:
 *   feed dev        Start dev mode with hot-reload
 *   feed tick       Execute a single tick (or loop with --loop)
 *   feed build      Bundle for production
 *   feed info       Show config and discovered systems
 *   feed document   Generate markdown reference from system metadata
 */

import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "feed",
    version: "0.1.0",
    description:
      "Feed Runtime — standalone system engine for the Feed simulation",
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
