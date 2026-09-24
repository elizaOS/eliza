import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, snapshotSource } from "../aosp/kernel-parity-evidence.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kernel-parity-evidence-"));
  directories.push(directory);
  mkdirSync(join(directory, "fixtures"));
  const binary = Buffer.from("test verifier executable");
  const digest = createHash("sha256").update(binary).digest("hex");
  const files = {
    gen_fixture_android_x86_64: binary,
    gen_fixture_host: binary,
    "host-selftest.txt": "all finite; fused-attn + tbq V-cache parity OK\n",
    "device-selftest.txt": "all finite; fused-attn + tbq V-cache parity OK\n",
    "device-binary-before.txt": `${digest}  /data/local/tmp/probe\n`,
    "device-binary-after.txt": `${digest}  /data/local/tmp/probe\n`,
    "device-abi.txt": "x86_64\n",
    "device-product.txt": "vsoc_x86_64_only\n",
    "device-fingerprint.txt": "test-fingerprint\n",
    "device-kernel.txt": "test-kernel\n",
    "compiler-version.txt": "test compiler\n",
    "ndk.properties": "test NDK\n",
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(directory, name), value);
  for (const name of [
    "turbo3",
    "turbo4",
    "turbo3_tcq",
    "qjl",
    "polar",
    "polar_qjl",
  ]) {
    writeFileSync(join(directory, "fixtures", `${name}.json`), "{}\n");
  }
  return directory;
}
const source = {
  commit: "a".repeat(40),
  files: { "fixture.c": "b".repeat(64) },
};
test("records binary, fixture, toolchain and guest evidence without exposing a serial", () => {
  const report = buildReport(source, source, fixture(), "private-device-id");
  expect(report.status).toBe("pass");
  expect(Object.keys(report.artifacts)).toHaveLength(18);
  expect(JSON.stringify(report)).not.toContain("private-device-id");
  expect(report.limits).toContain(
    "not full-engine ASR, assistant/IME or physical-device qualification",
  );
});
test("rejects changed source and mismatched host/device results", () => {
  const directory = fixture();
  expect(() =>
    buildReport(
      source,
      { ...source, commit: "c".repeat(40) },
      directory,
      "guest",
    ),
  ).toThrow("changed");
  writeFileSync(join(directory, "device-selftest.txt"), "failure\n");
  expect(() => buildReport(source, source, directory, "guest")).toThrow(
    "parity",
  );
});
test("rejects replacement of the guest binary before or after parity", () => {
  for (const phase of ["before", "after"]) {
    const directory = fixture();
    writeFileSync(
      join(directory, `device-binary-${phase}.txt`),
      `${"0".repeat(64)}  /data/local/tmp/probe\n`,
    );
    expect(() => buildReport(source, source, directory, "guest")).toThrow(
      "Device binary",
    );
  }
});
test("rejects a non-Cuttlefish target and incomplete artifact evidence", () => {
  const directory = fixture();
  writeFileSync(join(directory, "device-product.txt"), "physical-device\n");
  expect(() => buildReport(source, source, directory, "guest")).toThrow(
    "Cuttlefish",
  );
  writeFileSync(join(directory, "device-product.txt"), "vsoc_x86_64_only\n");
  rmSync(join(directory, "fixtures", "polar.json"));
  expect(() => buildReport(source, source, directory, "guest")).toThrow();
});

test("requires pinned clean tracked kernel inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "kernel-source-"));
  directories.push(root);
  const directory = join(root, "plugins/plugin-local-inference/native/verify");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "gen_fixture.c");
  writeFileSync(file, "original kernel source\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD").trim();
  expect(snapshotSource(root, commit).commit).toBe(commit);
  expect(() => snapshotSource(root, "0".repeat(40))).toThrow("source lock");
  writeFileSync(file, "changed kernel source\n");
  expect(() => snapshotSource(root, commit)).toThrow("tracked changes");
});
