#!/usr/bin/env node
/**
 * End-to-end self-test of the certification gate plumbing, used by the
 * `certification-verify-selftest` CI job and runnable locally. It exercises
 * the REAL CLIs (`certify:keygen` → `bundle:create` → `certify:rollup` →
 * `certify:sign` → `certify:verify`) against a throwaway keypair and a
 * throwaway fixture repo — no reimplementation of any verification logic —
 * and asserts:
 *
 *   1. a freshly signed certification verifies green (exit 0, ok:true),
 *   2. a tampered payload fails `bad-signature`,
 *   3. a missing committed bundle fails `bundle-tampered`,
 *   4. a tampered bundle artifact fails `bundle-tampered`,
 *   5. verification against a different trusted key fails `wrong-key`,
 *   6. an out-of-window certification fails `stale`,
 *   7. the commit-drift helper passes on match and rejects source drift,
 *   8. the summary renderer produces markdown from the real report.
 *
 * The throwaway private key exists only in this process's memory and child
 * env (ELIZA_CERT_SIGNING_KEY) — never on disk — matching the custody rules
 * in .github/certification/README.md.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_PKG = join(REPO_ROOT, "packages", "evidence");

const failures = [];
function step(name, ok, detail) {
  const marker = ok ? "ok  " : "FAIL";
  console.log(`[selftest] ${marker} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function runCli(scriptName, args, { env = {}, expectExit = 0 } = {}) {
  const result = spawnSync(
    "bun",
    ["run", "--cwd", EVIDENCE_PKG, scriptName, "--", ...args],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  if (result.error) throw result.error;
  const label = `${scriptName} ${args.join(" ")}`;
  console.log(`[selftest] $ bun run --cwd packages/evidence ${label}`);
  if (result.status !== expectExit) {
    console.log(result.stdout);
    console.error(result.stderr);
  }
  return result;
}

function failureCodes(stdout) {
  return JSON.parse(stdout).failures.map((failure) => failure.code);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const work = mkdtempSync(join(tmpdir(), "certification-selftest-"));
try {
  // -- keygen: throwaway trusted keypair + a second (wrong) keypair ---------
  const pubkeyPath = join(work, "trusted-public-key.pem");
  const keygen = runCli("certify:keygen", [
    "--print-private-key",
    "--pubkey-out",
    pubkeyPath,
  ]);
  const privatePem = keygen.stdout.slice(
    keygen.stdout.indexOf("-----BEGIN PRIVATE KEY-----"),
  );
  step("keygen produced a private key", privatePem.includes("PRIVATE KEY"));
  const signingEnv = {
    ELIZA_CERT_SIGNING_KEY: Buffer.from(privatePem).toString("base64"),
  };
  const wrongPubkeyPath = join(work, "wrong-public-key.pem");
  runCli("certify:keygen", ["--pubkey-out", wrongPubkeyPath]);

  // -- fixture repo: one lane result the e2e-recordings silo will ingest ----
  const fixtureRepo = join(work, "fixture-repo");
  mkdirSync(join(fixtureRepo, "e2e-recordings"), { recursive: true });
  writeFileSync(
    join(fixtureRepo, "e2e-recordings", "result.json"),
    JSON.stringify({ passed: 3, failed: 0, skipped: 0 }),
  );
  writeFileSync(join(fixtureRepo, "src.ts"), "export {};\n");
  git(fixtureRepo, ["init", "-b", "main"]);
  git(fixtureRepo, ["config", "user.email", "selftest@example.invalid"]);
  git(fixtureRepo, ["config", "user.name", "certification selftest"]);
  git(fixtureRepo, ["add", "-A"]);
  git(fixtureRepo, ["commit", "-m", "fixture tree"]);
  const fixtureCommit = git(fixtureRepo, ["rev-parse", "HEAD"]);

  // -- bundle + rollup + sign ------------------------------------------------
  const runsDir = join(work, "runs");
  const create = runCli("bundle:create", [
    "--tier",
    "full",
    "--repo-root",
    fixtureRepo,
    "--out",
    runsDir,
  ]);
  step("bundle:create succeeded", create.status === 0);
  const bundleDir = join(runsDir, readdirSync(runsDir)[0]);

  const verdictsPath = join(work, "verdicts.json");
  const rollup = runCli("certify:rollup", [
    "--bundle",
    bundleDir,
    "--out",
    verdictsPath,
  ]);
  step("certify:rollup succeeded", rollup.status === 0);

  const sign = runCli(
    "certify:sign",
    [
      "--bundle",
      bundleDir,
      "--verdicts",
      verdictsPath,
      "--reviewer-id",
      "certification-selftest",
      "--reviewer-kind",
      "agent",
    ],
    { env: signingEnv },
  );
  step("certify:sign succeeded", sign.status === 0);
  const certPath = join(bundleDir, "certification.json");

  const baseVerifyArgs = [
    "--cert",
    certPath,
    "--pubkey",
    pubkeyPath,
    "--expected-commit",
    fixtureCommit,
    "--max-age-hours",
    "72",
    "--required-tier",
    "full",
    "--bundle",
    bundleDir,
    "--json",
  ];

  // -- 1. green path ----------------------------------------------------------
  const green = runCli("certify:verify", baseVerifyArgs);
  step("valid certification verifies (exit 0)", green.status === 0);
  step("report.ok is true", JSON.parse(green.stdout).ok === true);
  const greenReportPath = join(work, "verify-report.json");
  writeFileSync(greenReportPath, green.stdout);

  // -- 2. tampered payload → bad-signature ------------------------------------
  const tamperedCertPath = join(work, "tampered-certification.json");
  const cert = JSON.parse(readFileSync(certPath, "utf8"));
  writeFileSync(
    tamperedCertPath,
    JSON.stringify({ ...cert, branch: "attacker-branch" }),
  );
  const tampered = runCli(
    "certify:verify",
    ["--cert", tamperedCertPath, "--pubkey", pubkeyPath, "--json"],
    { expectExit: 1 },
  );
  step("tampered payload exits 1", tampered.status === 1);
  step(
    "tampered payload reports bad-signature",
    failureCodes(tampered.stdout).includes("bad-signature"),
    failureCodes(tampered.stdout).join(","),
  );

  // -- 3. missing committed bundle → bundle-tampered ---------------------------
  const missingBundle = runCli(
    "certify:verify",
    [
      "--cert",
      certPath,
      "--pubkey",
      pubkeyPath,
      "--expected-commit",
      fixtureCommit,
      "--max-age-hours",
      "72",
      "--required-tier",
      "full",
      "--bundle",
      join(work, "missing-bundle"),
      "--json",
    ],
    { expectExit: 1 },
  );
  step("missing committed bundle exits 1", missingBundle.status === 1);
  step(
    "missing committed bundle reports bundle-tampered",
    failureCodes(missingBundle.stdout).includes("bundle-tampered"),
    failureCodes(missingBundle.stdout).join(","),
  );

  // -- 4. tampered bundle artifact → bundle-tampered ---------------------------
  appendFileSync(join(bundleDir, "lanes", "e2e", "result.json"), " ");
  const bundleTampered = runCli("certify:verify", baseVerifyArgs, {
    expectExit: 1,
  });
  step("tampered bundle exits 1", bundleTampered.status === 1);
  step(
    "tampered bundle reports bundle-tampered",
    failureCodes(bundleTampered.stdout).includes("bundle-tampered"),
    failureCodes(bundleTampered.stdout).join(","),
  );

  // -- 5. different trusted key → wrong-key ------------------------------------
  const wrongKey = runCli(
    "certify:verify",
    ["--cert", certPath, "--pubkey", wrongPubkeyPath, "--json"],
    { expectExit: 1 },
  );
  step("wrong trusted key exits 1", wrongKey.status === 1);
  step(
    "wrong trusted key reports wrong-key",
    failureCodes(wrongKey.stdout).includes("wrong-key"),
    failureCodes(wrongKey.stdout).join(","),
  );

  // -- 6. out-of-window certification → stale ----------------------------------
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500));
  const stale = runCli(
    "certify:verify",
    [
      "--cert",
      certPath,
      "--pubkey",
      pubkeyPath,
      // ~0.36s window: the 1.5s sleep above guarantees the cert is outside it.
      "--max-age-hours",
      "0.0001",
      "--json",
    ],
    { expectExit: 1 },
  );
  step("out-of-window certification exits 1", stale.status === 1);
  step(
    "out-of-window certification reports stale",
    failureCodes(stale.stdout).includes("stale"),
    failureCodes(stale.stdout).join(","),
  );

  // -- 7. drift helper: match passes, source drift fails ------------------------
  const driftScript = join(
    REPO_ROOT,
    "scripts",
    "certification",
    "check-commit-drift.mjs",
  );
  const driftMatch = spawnSync(
    "node",
    [
      driftScript,
      "--cert",
      certPath,
      "--head",
      fixtureCommit,
      "--repo",
      fixtureRepo,
    ],
    { encoding: "utf8" },
  );
  step("drift helper passes on commit match", driftMatch.status === 0);

  writeFileSync(join(fixtureRepo, "src.ts"), "export const drift = 1;\n");
  git(fixtureRepo, ["add", "-A"]);
  git(fixtureRepo, ["commit", "-m", "source drift"]);
  const driftedHead = git(fixtureRepo, ["rev-parse", "HEAD"]);
  const driftBad = spawnSync(
    "node",
    [
      driftScript,
      "--cert",
      certPath,
      "--head",
      driftedHead,
      "--repo",
      fixtureRepo,
    ],
    { encoding: "utf8" },
  );
  step("drift helper rejects source drift", driftBad.status === 1);

  // -- 8. renderer produces markdown from the real report -----------------------
  const renderScript = join(
    REPO_ROOT,
    "scripts",
    "certification",
    "render-check-summary.mjs",
  );
  const summary = spawnSync(
    "node",
    [
      renderScript,
      "--mode",
      "summary",
      "--report",
      greenReportPath,
      "--pubkey",
      pubkeyPath,
      "--cert-path",
      "selftest certification.json",
    ],
    { encoding: "utf8" },
  );
  step(
    "renderer emits the verdict table",
    summary.status === 0 &&
      summary.stdout.includes("certification verified") &&
      summary.stdout.includes("lane:e2e"),
  );
  console.log("\n[selftest] rendered summary preview:\n");
  console.log(summary.stdout);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n[selftest] FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\n[selftest] all certification gate plumbing checks passed");
