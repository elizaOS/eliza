#!/usr/bin/env node
import { runAutonomousCli } from "./cli/index.js";

runAutonomousCli().catch((error) => {
  console.error(
    "[eliza-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
