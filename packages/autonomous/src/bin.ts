#!/usr/bin/env node
import { runAutonomousCli } from "./cli";

runAutonomousCli().catch((error) => {
  console.error(
    "[milady-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
