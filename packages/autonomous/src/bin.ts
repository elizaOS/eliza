#!/usr/bin/env node
import '@ensdomains/ethers-patch-v6';
import { runAutonomousCli } from "./cli";

runAutonomousCli().catch((error) => {
  console.error(
    "[eliza-autonomous] Failed to start:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
