#!/usr/bin/env node
// OS-3 enforcement-artifact generator (plan §3-§4).
//
// Turns confidential-policy.json into the static, boot-consumable files the
// reproducible image installs into the rootfs:
//
//   packages/os/linux/confidential/cmdline.conf            kernel-cmdline fragment
//   packages/os/linux/confidential/sysctl.d/99-confidential.conf   sysctl drop-in
//   packages/os/linux/confidential/masked-units.txt        systemd masked units
//
// The mapping (which policy setting produces which line) lives in
// confidential-enforcement-map.mjs so the generator and the checker share one
// source of truth. Re-run this whenever the policy changes; the
// check-confidential-artifacts.mjs gate fails closed if the artifacts drift.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/generate-confidential-artifacts.mjs
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_HEADER,
  expectedCmdlineTokens,
  expectedMaskedUnits,
  expectedSysctlEntries,
} from "./confidential-enforcement-map.mjs";
import { parseArgs, readJson, repoRoot } from "./os-release-lib.mjs";

const CONFIDENTIAL_DIR = path.join(repoRoot, "packages/os/linux/confidential");
const DEFAULT_POLICY = path.join(
  CONFIDENTIAL_DIR,
  "policy/confidential-policy.json",
);

export const ARTIFACT_PATHS = {
  cmdline: path.join(CONFIDENTIAL_DIR, "cmdline.conf"),
  sysctl: path.join(CONFIDENTIAL_DIR, "sysctl.d/99-confidential.conf"),
  masked: path.join(CONFIDENTIAL_DIR, "masked-units.txt"),
};

// Render the exact bytes for each artifact from the policy. Pure (no I/O) so the
// checker can compare against on-disk bytes without re-implementing formatting.
export function renderArtifacts(policy) {
  const cmdline = [
    ...ARTIFACT_HEADER("cmdline.conf"),
    ...expectedCmdlineTokens(policy),
    "",
  ].join("\n");
  const sysctl = [
    ...ARTIFACT_HEADER("sysctl.d/99-confidential.conf"),
    ...expectedSysctlEntries(policy),
    "",
  ].join("\n");
  const masked = [
    ...ARTIFACT_HEADER("masked-units.txt"),
    ...expectedMaskedUnits(policy),
    "",
  ].join("\n");
  return { cmdline, sysctl, masked };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath =
    typeof args.policy === "string" ? args.policy : DEFAULT_POLICY;
  const policy = await readJson(policyPath);
  const rendered = renderArtifacts(policy);

  await mkdir(path.dirname(ARTIFACT_PATHS.sysctl), { recursive: true });
  await writeFile(ARTIFACT_PATHS.cmdline, rendered.cmdline);
  await writeFile(ARTIFACT_PATHS.sysctl, rendered.sysctl);
  await writeFile(ARTIFACT_PATHS.masked, rendered.masked);

  console.log(`confidential enforcement artifacts written from ${policyPath}:`);
  console.log(`  ${ARTIFACT_PATHS.cmdline}`);
  console.log(`  ${ARTIFACT_PATHS.sysctl}`);
  console.log(`  ${ARTIFACT_PATHS.masked}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
