#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePaths = [
  "plugins/plugin-local-inference/native/reference",
  "plugins/plugin-local-inference/native/verify",
  "plugins/plugin-local-inference/native/vulkan",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (directory, name) => readFileSync(join(directory, name));
const value = (directory, name) =>
  read(directory, name).toString("utf8").trim();

export function snapshotSource(root, expectedCommit) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const commit = git("rev-parse", "HEAD").trim();
  if (commit !== expectedCommit || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Kernel source does not match the OS source lock.");
  }
  if (
    git(
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ...sourcePaths,
    ).trim()
  ) {
    throw new Error("Kernel source contains tracked changes.");
  }
  const paths = git("ls-files", "-z", "--", ...sourcePaths)
    .split("\0")
    .filter(Boolean)
    .sort();
  if (!paths.some((path) => path.endsWith("/verify/gen_fixture.c"))) {
    throw new Error("Kernel source inventory is incomplete.");
  }
  return {
    commit,
    files: Object.fromEntries(
      paths.map((path) => [path, sha256(readFileSync(join(root, path)))]),
    ),
  };
}

export function buildReport(before, after, directory, serial) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Kernel source or runner changed during qualification.");
  }
  const host = value(directory, "host-selftest.txt");
  const device = value(directory, "device-selftest.txt");
  if (
    !host ||
    host !== device ||
    !/all finite; fused-attn \+ tbq V-cache( \+ split-K online-softmax merge)? parity OK/.test(
      device,
    )
  ) {
    throw new Error("Device parity output does not match the host.");
  }
  const binary = sha256(read(directory, "gen_fixture_android_x86_64"));
  for (const phase of ["before", "after"]) {
    const recorded = value(directory, `device-binary-${phase}.txt`);
    if (
      !/^[a-f0-9]{64}\s+\S+$/.test(recorded) ||
      recorded.split(/\s+/)[0] !== binary
    ) {
      throw new Error(
        "Device binary differs from the compiled kernel verifier.",
      );
    }
  }
  const abi = value(directory, "device-abi.txt");
  const product = value(directory, "device-product.txt");
  const fingerprint = value(directory, "device-fingerprint.txt");
  const kernel = value(directory, "device-kernel.txt");
  if (
    abi !== "x86_64" ||
    !product.startsWith("vsoc_x86_64") ||
    !fingerprint ||
    !kernel ||
    !serial
  ) {
    throw new Error(
      "Device evidence is not an identified x86_64 Cuttlefish guest.",
    );
  }
  const artifacts = [
    "gen_fixture_android_x86_64",
    "gen_fixture_host",
    "host-selftest.txt",
    "device-selftest.txt",
    "device-binary-before.txt",
    "device-binary-after.txt",
    "device-abi.txt",
    "device-product.txt",
    "device-fingerprint.txt",
    "device-kernel.txt",
    "compiler-version.txt",
    "ndk.properties",
    ...["turbo3", "turbo4", "turbo3_tcq", "qjl", "polar", "polar_qjl"].map(
      (name) => `fixtures/${name}.json`,
    ),
  ];
  return {
    schemaVersion: 1,
    status: "pass",
    gate: "android-x86_64-cpu-kernel-reference-parity",
    createdAt: new Date().toISOString(),
    source: before,
    device: { abi, product, fingerprint, kernel, serialSha256: sha256(serial) },
    artifacts: Object.fromEntries(
      artifacts.map((name) => [name, sha256(read(directory, name))]),
    ),
    limits: [
      "Cuttlefish CPU kernel parity only",
      "not full-engine ASR, assistant/IME or physical-device qualification",
      "software Vulkan diagnostics do not establish hardware readiness",
    ],
  };
}

function main() {
  const [mode, sourceRoot, output, evidence] = process.argv.slice(2);
  if (
    !sourceRoot ||
    !output ||
    !["begin", "finish"].includes(mode) ||
    (mode === "finish" && !evidence)
  ) {
    throw new Error(
      "usage: kernel-parity-evidence.mjs begin|finish SOURCE OUT [EVIDENCE]",
    );
  }
  const lock = JSON.parse(
    readFileSync(
      new URL(
        "../../release/eliza-source.lock.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const current = {
    ...snapshotSource(resolve(sourceRoot), lock.commit),
    runnerSha256: sha256(
      readFileSync(
        new URL("cuttlefish-native-inference-smoke.sh", import.meta.url),
      ),
    ),
    reporterSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  };
  if (mode === "begin") {
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, "kernel-inputs.json"),
      `${JSON.stringify(current, null, 2)}\n`,
      { flag: "wx" },
    );
    return;
  }
  const before = JSON.parse(value(output, "kernel-inputs.json"));
  const report = buildReport(
    before,
    current,
    output,
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Standalone adb qualification is not a cached Turbo task.
    process.env.ANDROID_SERIAL,
  );
  mkdirSync(dirname(resolve(evidence)), { recursive: true });
  writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
