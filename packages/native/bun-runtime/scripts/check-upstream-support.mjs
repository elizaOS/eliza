#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const strict = args.has("--strict");
const npmExecPath =
  process.env.npm_execpath && /(^|[/\\])bun(x)?$/.test(process.env.npm_execpath)
    ? process.env.npm_execpath
    : "";
const bun = process.env.BUN_BIN || npmExecPath || "bun";

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ??
      (result.error ? `${result.error.name}: ${result.error.message}` : ""),
    error: result.error,
  };
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

const versionProbe = run(bun, ["--version"]);
const revisionProbe =
  versionProbe.status === 0 ? run(bun, ["--revision"]) : { stdout: "" };
const version = versionProbe.stdout.trim();
const revision = revisionProbe.stdout.trim();
const probes =
  versionProbe.status === 0
    ? [
        probeCompileTarget("bun-ios-arm64"),
        probeCompileTarget("bun-ios-arm64-simulator"),
      ]
    : [];
const supported = probes.some((probe) => probe.ok);
const payload = {
  bun,
  version,
  revision,
  supported,
  ...(versionProbe.status === 0
    ? {}
    : {
        error:
          versionProbe.stderr ||
          `Unable to execute ${bun}. Install Bun or set BUN_BIN=/path/to/bun.`,
      }),
  probes,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  if (versionProbe.status !== 0) {
    console.log(
      `[bun-ios-runtime] ${payload.error ?? `Unable to execute ${bun}`}`,
    );
  }
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
