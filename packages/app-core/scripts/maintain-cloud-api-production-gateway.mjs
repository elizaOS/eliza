#!/usr/bin/env node
/**
 * Verify production Cloud API gateway contract, repairing only on drift.
 *
 * This is safe for repeated operator runs: it verifies first and only deploys
 * when the live Worker no longer returns +14159611510/bluebubbles/blooio.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verifyScript = path.join(scriptDir, "verify-cloud-api-production-deploy.mjs");
const deployScript = path.join(scriptDir, "deploy-cloud-api-production-gateway.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 300_000,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function main() {
  console.log("[cloud-api-gateway-maintain] verifying production gateway contract");
  const first = run("node", [verifyScript], { timeout: 180_000 });
  if (first.status === 0) {
    process.stdout.write(first.output);
    console.log("[cloud-api-gateway-maintain] PASS no repair needed");
    return;
  }

  process.stdout.write(first.output);
  console.log("[cloud-api-gateway-maintain] drift detected; running production repair deploy");
  const repair = run("node", [deployScript], { inherit: true, timeout: 600_000 });
  if (repair.status !== 0) {
    throw new Error(`production repair deploy failed with ${repair.status}`);
  }
  console.log("[cloud-api-gateway-maintain] PASS repaired production gateway contract");
}

try {
  main();
} catch (error) {
  console.error(
    `[cloud-api-gateway-maintain] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
