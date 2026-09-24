#!/usr/bin/env node
/** Standalone read-only post-install verification using the signed contract. */
import path from "node:path";
import {
  checkedRun,
  parseOptions,
  pinnedToolRunner,
  toolPaths,
} from "./install-release.ts";
import { readHealthToken, verifyPostBoot } from "./post-boot.ts";
import {
  loadPolicy,
  readJson,
  requireThat,
  validateEnvelope,
} from "./release-contract.ts";
import { readAndroidHealth } from "./runtime-health.ts";

try {
  const o = parseOptions(process.argv.slice(2));
  requireThat(
    !o.confirm &&
      !o.wipe &&
      !o.reboot &&
      o.serial &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(o.serial) &&
      o.toolDir &&
      ["a", "b"].includes(o.slot),
    "provide --manifest, --artifact-dir, --device, --tool-dir and exact --slot; no write options",
  );
  const { release, subjectSha256 } = validateEnvelope(
    readJson(o.manifest),
    loadPolicy(),
  );
  requireThat(release.target.kind === "physical", "physical release required");
  if (o.execute) {
    const healthToken = readHealthToken(o.healthTokenFile);
    const tools = toolPaths(path.resolve(o.toolDir), release, checkedRun);
    const run = pinnedToolRunner(tools, release);
    const result = verifyPostBoot(
      release,
      (args, options) =>
        run(tools.adb, ["-s", o.serial, "shell", ...args], options),
      o.slot,
      healthToken,
      (token) => readAndroidHealth(tools.adb, o.serial, token),
    );
    process.stdout.write(`${JSON.stringify({ subjectSha256, ...result })}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({ subjectSha256, execution: false, device: o.serial, expectedSlot: o.slot })}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
