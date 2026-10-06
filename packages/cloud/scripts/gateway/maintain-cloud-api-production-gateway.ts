#!/usr/bin/env node
/**
 * Verify production Cloud API gateway contract, repairing only on drift.
 *
 * This is safe for repeated operator runs: it verifies first and only deploys
 * when the verifier exits with the explicit drift code (the live Worker no
 * longer returns +14159611510/bluebubbles/blooio). Any other verifier failure
 * (network, auth, crash, signal, timeout) aborts without touching production.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GATEWAY_CONTRACT_DRIFT_EXIT_CODE } from "./cloud-api-gateway-contract.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verifyScript = path.join(
  scriptDir,
  "verify-cloud-api-production-deploy.ts",
);
const deployScript = path.join(
  scriptDir,
  "deploy-cloud-api-production-gateway.ts",
);

/**
 * Normalize a spawnSync result. A null status means the child never exited
 * normally (signal, timeout, spawn failure) and is always a failure.
 */
export function childRunResult(result) {
  const failure = result.error
    ? `spawn failed: ${result.error.message}`
    : result.status === null
      ? `terminated by ${result.signal ?? "unknown signal"}`
      : null;
  return {
    status: result.status,
    failure,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function run(command, args, options = {}) {
  return childRunResult(
    spawnSync(command, args, {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 300_000,
    }),
  );
}

function describeExit(result) {
  return result.failure ?? `exit ${result.status}`;
}

export function maintainGateway({
  verify = () => run("node", [verifyScript], { timeout: 180_000 }),
  deploy = () =>
    run("node", [deployScript], { inherit: true, timeout: 600_000 }),
  log = (line) => console.log(line),
  write = (text) => process.stdout.write(text),
} = {}) {
  log("[cloud-api-gateway-maintain] verifying production gateway contract");
  const first = verify();
  write(first.output);
  if (first.failure === null && first.status === 0) {
    log("[cloud-api-gateway-maintain] PASS no repair needed");
    return { repaired: false };
  }
  if (
    first.failure !== null ||
    first.status !== GATEWAY_CONTRACT_DRIFT_EXIT_CODE
  ) {
    throw new Error(
      `production gateway verifier failed (${describeExit(first)}); not deploying because no drift was reported`,
    );
  }

  log(
    "[cloud-api-gateway-maintain] drift detected; running production repair deploy",
  );
  const repair = deploy();
  if (repair.failure !== null || repair.status !== 0) {
    throw new Error(
      `production repair deploy failed (${describeExit(repair)})`,
    );
  }
  log("[cloud-api-gateway-maintain] PASS repaired production gateway contract");
  return { repaired: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    maintainGateway();
  } catch (error) {
    console.error(
      `[cloud-api-gateway-maintain] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
