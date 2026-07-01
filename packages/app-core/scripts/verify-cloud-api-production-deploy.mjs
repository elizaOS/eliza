#!/usr/bin/env node
/**
 * Production Cloud API smoke for the shared SMS gateway contract.
 *
 * This proves the deployed Worker returns the gateway identity fields required
 * by the onboarding verifier. When Wrangler auth is available, it also reports
 * the newest visible production Worker version for deployment traceability.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const cloudApiDir = path.join(repoRoot, "packages", "cloud", "api");
const onboardingVerifier = path.join(
  scriptDir,
  "verify-cloud-sms-onboarding-flow.mjs",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
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
    throw new Error(
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
  process.exit(1);
}
