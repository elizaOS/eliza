#!/usr/bin/env node
/**
 * Build, deploy, and verify the production Cloud API gateway contract.
 *
 * This is intentionally scoped to the shared SMS gateway objective: after
 * deploying, it must prove the live Worker returns the gateway identity fields
 * for +14159611510/bluebubbles/blooio.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const cloudApiDir = path.join(repoRoot, "packages", "cloud-api");
const verifyScript = path.join(scriptDir, "verify-cloud-api-production-deploy.mjs");

function run(command, args, options = {}) {
  console.log(`[cloud-api-gateway-deploy] run: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 300_000,
  });
  if (result.status !== 0) {
    const output =
      result.stdout || result.stderr
        ? `${result.stdout ?? ""}${result.stderr ?? ""}`
        : result.error instanceof Error
          ? result.error.message
          : "";
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
  return result;
}

function main() {
  run("bun", ["run", "build"], { cwd: cloudApiDir, inherit: true });
  run("bun", ["run", "deploy"], { cwd: cloudApiDir, inherit: true });
  run("node", [verifyScript], { cwd: repoRoot, inherit: true, timeout: 180_000 });
  console.log("[cloud-api-gateway-deploy] PASS production Cloud API gateway contract deployed and verified.");
}

try {
  main();
} catch (error) {
  console.error(
    `[cloud-api-gateway-deploy] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
