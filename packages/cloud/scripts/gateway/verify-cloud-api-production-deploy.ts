#!/usr/bin/env node
/**
 * Production Cloud API smoke for the shared SMS gateway contract.
 *
 * This proves the deployed Worker returns the gateway identity fields required
 * by the onboarding verifier. When Wrangler auth is available, it also reports
 * the newest visible production Worker version for deployment traceability.
 *
 * Exit codes: 0 = contract holds, GATEWAY_CONTRACT_DRIFT_EXIT_CODE = the live
 * Worker answered with a drifted gateway identity (repairable by redeploy),
 * 1 = the verifier itself failed (network, auth, crash, signal).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_CONTRACT_DRIFT_EXIT_CODE,
  GatewayContractDriftError,
} from "./cloud-api-gateway-contract.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const cloudApiDir = path.join(repoRoot, "packages", "cloud", "api");
const onboardingVerifier = path.join(
  scriptDir,
  "verify-cloud-sms-onboarding-flow.ts",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
  // A null status means the child never exited normally (killed by a signal,
  // timed out, or failed to spawn). That is a failure, never success.
  const failure = result.error
    ? `\n${command} failed: ${result.error.message}`
    : result.status === null
      ? `\n${command} terminated by ${result.signal ?? "unknown signal"}`
      : "";
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${failure}`,
  };
}

function latestWorkerVersion() {
  const result = run(
    "bun",
    ["wrangler", "versions", "list", "--env", "production"],
    {
      cwd: cloudApiDir,
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      detail:
        result.output.replace(/\s+/g, " ").trim().slice(0, 300) ||
        "wrangler failed",
    };
  }

  const matches = [
    ...result.output.matchAll(
      /Version ID:\s+([0-9a-f-]{36})\s+Created:\s+([0-9:.TZ-]+)/g,
    ),
  ];
  const latest = matches.at(-1);
  if (!latest) {
    return {
      ok: false,
      detail: "could not parse Worker versions output",
    };
  }
  return {
    ok: true,
    versionId: latest[1],
    created: latest[2],
  };
}

function main() {
  const version = latestWorkerVersion();
  const onboarding = run("node", [onboardingVerifier], { timeout: 180_000 });
  if (onboarding.status === GATEWAY_CONTRACT_DRIFT_EXIT_CODE) {
    throw new GatewayContractDriftError(
      onboarding.output.trim() || "cloud onboarding verifier reported drift",
    );
  }
  if (onboarding.status !== 0) {
    throw new Error(
      onboarding.output.trim() || "cloud onboarding verifier failed",
    );
  }
  const summary = onboarding.output.trim().split(/\r?\n/).at(-1) ?? "";
  if (
    !/gateway=\+14159611510/.test(summary) ||
    !/device=\+14159611510\/bluebubbles\/blooio/.test(summary) ||
    !/registered=yes/.test(summary)
  ) {
    throw new GatewayContractDriftError(
      `Cloud onboarding verifier returned unexpected summary: ${summary}`,
    );
  }

  const versionText = version.ok
    ? `version=${version.versionId} created=${version.created}`
    : `version=unknown (${version.detail})`;
  console.log(`[cloud-api-prod] PASS ${versionText} ${summary}`);
}

try {
  main();
} catch (error) {
  console.error(
    `[cloud-api-prod] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(error instanceof GatewayContractDriftError ? error.exitCode : 1);
}
