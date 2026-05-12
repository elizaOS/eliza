#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const strict = args.has("--strict");
const bun = process.env.BUN_BIN || process.env.npm_execpath || "bun";

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function probeCompileTarget(target) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bun-ios-target-"));
  const input = path.join(tmp, "index.ts");
  const output = path.join(tmp, "app");
  fs.writeFileSync(input, 'console.log("target probe")\n');
  const result = run(bun, [
    "build",
    "--compile",
    `--target=${target}`,
    input,
    "--outfile",
    output,
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return {
    target,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

const version = run(bun, ["--version"]).stdout.trim();
const revision = run(bun, ["--revision"]).stdout.trim();
const probes = [
  probeCompileTarget("bun-ios-arm64"),
  probeCompileTarget("bun-ios-arm64-simulator"),
];
const supported = probes.some((probe) => probe.ok);
const payload = {
  bun,
  version,
  revision,
  supported,
  probes,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`[bun-ios-runtime] bun ${revision || version || "<unknown>"}`);
  for (const probe of probes) {
    console.log(
      `[bun-ios-runtime] ${probe.target}: ${probe.ok ? "supported" : "unsupported"}`,
    );
    if (!probe.ok && probe.stderr) {
      console.log(probe.stderr);
    }
  }
}

if (strict && !supported) {
  process.exitCode = 1;
}
