#!/usr/bin/env node
/**
 * One-command local certification fallback (#14548). Runs the exact chain
 * the vast.ai onstart runs — packages/evidence bundle:create →
 * certify:rollup → certify:sign — on this machine, so when vast is down or
 * the API key is dead a certifier holding ELIZA_CERT_SIGNING_KEY can produce
 * the same signed certification.json the develop→main gate verifies. Same
 * commands, same output; the gate cannot tell the difference (by design —
 * the signature is what matters).
 *
 * Signing enforces its own honesty: certify:sign refuses to sign
 * mechanically non-pass subjects as pass, so "one command" cannot fabricate
 * a green certification. Use --no-sign to stop after rollup, hand-review
 * verdicts.json (waivers require notes), then run certify:sign yourself —
 * that is the diligent-reviewer path the trust model expects.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SIGNING_KEY_ENV_VAR = "ELIZA_CERT_SIGNING_KEY";
const TIERS = ["cpu", "gpu", "full"];

const USAGE = `Usage: node scripts/vast/local-certify.mjs [--tier cpu|gpu|full] [options]

Options:
  --tier <cpu|gpu|full>   Certification tier (default: full)
  --reviewer-id <id>      Reviewer identity in the signed cert (default: $USER@host)
  --no-sign               Stop after rollup for hand review of verdicts.json
  --help                  This text

Requires env ${SIGNING_KEY_ENV_VAR} (PEM or base64-wrapped PEM) unless --no-sign.
Output: the bundle dir under evidence/runs/ with certification.json inside,
plus a copy of certification.json at the repo root ready to commit on the
promotion branch (bundle → evidence/bundle/ per .github/certification/README.md).`;

function parseArgs(argv) {
  const opts = {
    tier: "full",
    reviewerId: `${os.userInfo().username}@${os.hostname()}`,
    sign: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tier") {
      opts.tier = argv[++index];
      if (!TIERS.includes(opts.tier)) {
        throw new Error(
          `--tier must be one of ${TIERS.join("|")}, got: ${opts.tier}`,
        );
      }
    } else if (arg === "--reviewer-id") {
      const value = argv[++index];
      if (!value) throw new Error("--reviewer-id requires a value");
      opts.reviewerId = value;
    } else if (arg === "--no-sign") {
      opts.sign = false;
    } else if (arg === "--help") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

function run(label, command, args) {
  console.log(`\n[local-certify] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? "signal"})`);
  }
}

function newestBundleDir() {
  const runsDir = path.join(REPO_ROOT, "evidence", "runs");
  const entries = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(runsDir, entry.name);
      return { dir, mtimeMs: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length === 0) {
    throw new Error(`no bundle directory appeared under ${runsDir}`);
  }
  return entries[0].dir;
}

function main(argv, env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.sign && !env[SIGNING_KEY_ENV_VAR]) {
    console.error(
      `[local-certify] no signing key: export ${SIGNING_KEY_ENV_VAR} (or use --no-sign to produce reviewable verdicts without signing)`,
    );
    return 2;
  }

  run("bundle:create", "bun", [
    "run",
    "--cwd",
    "packages/evidence",
    "bundle:create",
    "--",
    "--tier",
    opts.tier,
  ]);
  const bundleDir = newestBundleDir();
  const verdictsPath = path.join(bundleDir, "verdicts.json");
  run("certify:rollup", "bun", [
    "run",
    "--cwd",
    "packages/evidence",
    "certify:rollup",
    "--",
    "--bundle",
    bundleDir,
    "--out",
    verdictsPath,
  ]);

  if (!opts.sign) {
    console.log(`\n[local-certify] stopped before signing (--no-sign).`);
    console.log(`[local-certify] review ${verdictsPath}, then:`);
    console.log(
      `  bun run --cwd packages/evidence certify:sign -- --bundle ${bundleDir} --verdicts ${verdictsPath} --reviewer-id <you> --reviewer-kind human`,
    );
    return 0;
  }

  run("certify:sign", "bun", [
    "run",
    "--cwd",
    "packages/evidence",
    "certify:sign",
    "--",
    "--bundle",
    bundleDir,
    "--verdicts",
    verdictsPath,
    "--reviewer-id",
    opts.reviewerId,
    "--reviewer-kind",
    "human",
  ]);

  const certSource = path.join(bundleDir, "certification.json");
  const certTarget = path.join(REPO_ROOT, "certification.json");
  fs.copyFileSync(certSource, certTarget);
  console.log(`\n[local-certify] done.`);
  console.log(`[local-certify] bundle:        ${bundleDir}`);
  console.log(
    `[local-certify] certification: ${certTarget} (copied from the bundle)`,
  );
  console.log(
    `[local-certify] for a promotion PR also commit the bundle: rm -rf evidence/bundle && mkdir -p evidence && cp -R '${bundleDir}' evidence/bundle`,
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2), process.env);
} catch (error) {
  console.error(`[local-certify] ${error.message}`);
  process.exitCode = 1;
}
