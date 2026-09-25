#!/usr/bin/env node
/** Verify the production filesystem service with the staged Android Bun runtime. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { acquireDeviceLease } from "./lib/device-lease.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--serial", "--runtime-dir"].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  ) {
    throw new Error(
      "Usage: android-native-filesystem.ts --serial <emulator> --runtime-dir <staged agent/x86_64>",
    );
  }
}
const serial = option("--serial") ?? "";
const runtimeDir = option("--runtime-dir");
if (!serial || !runtimeDir)
  throw new Error("Explicit --serial and --runtime-dir are required");
const runtime = path.resolve(runtimeDir);
const names = [
  "bun",
  "ld-musl-x86_64.so.1",
  "ld-musl-x86_64.so.1.real",
  "libgcc_s.so.1",
  "libstdc++.so.6.0.33",
  "libsigsys-handler.so",
];
for (const name of names)
  if (!fs.statSync(path.join(runtime, name)).isFile())
    throw new Error(`Missing runtime file ${name}`);
const output = testOutputPath(
  "android-native-filesystem",
  new Date().toISOString().replaceAll(":", "-"),
);
fs.mkdirSync(output, { recursive: true });
const remote = `/data/local/tmp/eliza-filesystem-${randomUUID()}`;
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function adb(...command: string[]) {
  return execFileSync("adb", ["-s", serial, ...command], {
    encoding: "utf8",
    timeout: 120000,
  });
}
function shell(command: string) {
  return adb("shell", command);
}
const lease = await acquireDeviceLease(`android:${serial}`, { waitMs: 0 });
const report: Record<string, unknown> = {
  serial,
  startedAt: new Date().toISOString(),
  pass: false,
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  worktreeChanges: execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }),
  scope:
    "Production service, Node backend, staged Android Bun, shell UID. Does not certify Capacitor backend or installed-app sandbox.",
  runtimeSha256: Object.fromEntries(
    names.map((name) => [name, hash(path.join(runtime, name))]),
  ),
};
let remoteCreated = false;
try {
  if (!["ranchu", "goldfish"].includes(shell("getprop ro.hardware").trim()))
    throw new Error("Only stock emulators are supported");
  if (shell("getprop ro.product.cpu.abi").trim() !== "x86_64")
    throw new Error("This lane requires x86_64");
  report.deviceFingerprint = shell("getprop ro.build.fingerprint").trim();
  const bundle = path.join(output, "contract.js");
  fs.writeFileSync(
    path.join(output, "build.log"),
    execFileSync(
      "bun",
      [
        "build",
        "packages/app/test/android-native-filesystem/contract.ts",
        "--target=bun",
        "--conditions=eliza-source",
        `--outfile=${bundle}`,
      ],
      { cwd: root, encoding: "utf8", timeout: 120000 },
    ),
  );
  report.bundleSha256 = hash(bundle);
  shell(`mkdir ${remote}`);
  remoteCreated = true;
  for (const name of names)
    adb("push", path.join(runtime, name), `${remote}/${name}`);
  adb("push", bundle, `${remote}/contract.js`);
  shell(
    `chmod 755 ${remote}/bun ${remote}/ld-musl-x86_64.so.1 ${remote}/ld-musl-x86_64.so.1.real`,
  );
  shell(`ln -s libstdc++.so.6.0.33 ${remote}/libstdc++.so.6`);
  const artifacts = [];
  for (const phase of ["write", "reopen"]) {
    const execution = spawnSync(
      "adb",
      [
        "-s",
        serial,
        "shell",
        `cd ${remote} && ELIZA_STATE_DIR=${remote}/state LD_LIBRARY_PATH=${remote} ./ld-musl-x86_64.so.1 ./bun contract.js ${phase}`,
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    fs.writeFileSync(
      path.join(output, `${phase}.log`),
      (execution.stdout ?? "") + (execution.stderr ?? ""),
    );
    if (execution.error || execution.status !== 0)
      throw new Error(
        `${phase} failed: ${execution.error ?? execution.status}; see ${phase}.log`,
      );
    const artifact = path.join(output, `${phase}.json`);
    adb("pull", `${remote}/state/${phase}.json`, artifact);
    const result = JSON.parse(fs.readFileSync(artifact, "utf8"));
    if (result.pass !== true || result.phase !== phase)
      throw new Error(`${phase} did not finish`);
    artifacts.push({
      path: `${phase}.json`,
      bytes: fs.statSync(artifact).size,
      sha256: hash(artifact),
    });
  }
  report.artifacts = artifacts;
  report.pass = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  try {
    if (remoteCreated) shell(`rm -rf ${remote}`);
    report.cleanup = "complete";
  } catch (error) {
    report.cleanupError = String(error);
    report.pass = false;
    process.exitCode = 1;
  } finally {
    lease.release();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `${report.pass ? "PASS" : "FAIL"}: ${path.join(output, "report.json")}`,
    );
  }
}
