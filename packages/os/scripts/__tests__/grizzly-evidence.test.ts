import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capture,
  captureEvidence,
  selectEvidenceTransports,
} from "../distro-android/grizzly-evidence.mjs";

test("evidence selection uses serial and transport state, not model metadata", () => {
  expect(
    selectEvidenceTransports({ fastbootOutput: "phone\tROM Recovery\n" }),
  ).toEqual({ device: "phone", adb: false, fastboot: true });
  expect(() =>
    selectEvidenceTransports({
      fastbootOutput: "phone\tROM Recovery\n",
      adbOutput: "other device\n",
    }),
  ).toThrow("multiple devices");
  const adbOutput =
    "List of devices attached\nother device product:device\nphone unauthorized model:device device:recovery\n";
  expect(selectEvidenceTransports({ device: "phone", adbOutput })).toEqual({
    device: "phone",
    adb: false,
    fastboot: false,
  });
  expect(selectEvidenceTransports({ device: "missing", adbOutput }).adb).toBe(
    false,
  );
  expect(() => selectEvidenceTransports({ adbOutput })).toThrow(
    "multiple devices",
  );
  for (const state of ["offline", "unauthorized", "sideload"]) {
    expect(
      selectEvidenceTransports({ adbOutput: `phone ${state} model:device\n` })
        .adb,
    ).toBe(false);
  }
  for (const state of ["device", "recovery"]) {
    expect(
      selectEvidenceTransports({ adbOutput: `phone ${state}\n` }).adb,
    ).toBe(true);
  }
});

test("evidence selection rejects cross-transport ambiguity and ignores daemon messages", () => {
  expect(() =>
    selectEvidenceTransports({
      adbOutput: "phone device",
      fastbootOutput: "other fastboot",
    }),
  ).toThrow("multiple devices");
  expect(
    selectEvidenceTransports({
      adbOutput: "* daemon started successfully *\nList of devices attached\n",
      fastbootOutput: "",
    }),
  ).toEqual({ device: null, adb: false, fastboot: false });
  expect(
    selectEvidenceTransports({
      device: "phone",
      fastbootOutput: "other fastboot",
    }).fastboot,
  ).toBe(false);
});

test("capture binds all probes to one serial and never changes MTE or boot state", () => {
  const root = mkdtempSync(join(tmpdir(), "grizzly-evidence-test-"));
  const calls: { name: string; command: string; args: string[] }[] = [];
  try {
    const out = captureEvidence(
      { device: "phone", outRoot: root },
      (_dir: string, name: string, command: string, args: string[]) => {
        calls.push({ name, command, args });
        return {
          succeeded: true,
          stdout:
            name === "adb-devices"
              ? "phone recovery\nother device\n"
              : name === "fastboot-devices"
                ? "phone fastboot\n"
                : name === "fastboot-product"
                  ? "product: grizzly\n"
                  : name === "adb-product"
                    ? "grizzly\n"
                    : "",
        };
      },
    );
    expect(
      JSON.parse(readFileSync(join(out, "device-selection.json"), "utf8"))
        .device,
    ).toBe("phone");
    for (const call of calls.slice(2)) {
      expect(call.args.slice(0, 2)).toEqual(["-s", "phone"]);
      expect(call.args).not.toContain("reboot");
      expect(call.args).not.toContain("flash");
      expect(call.args).not.toContain("erase");
      expect(call.args).not.toContain("mte");
    }
    expect(calls.map((call) => call.name)).toEqual(
      expect.arrayContaining([
        "cpuinfo",
        "kernel-cmdline",
        "kernel-bootconfig",
        "super-size",
        "logical-partitions",
        "apex-list",
        "service-list",
      ]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed inventory cannot authorize probes even with plausible stdout", () => {
  const root = mkdtempSync(join(tmpdir(), "grizzly-evidence-failure-"));
  const calls: string[] = [];
  try {
    captureEvidence(
      { device: "phone", outRoot: root },
      (_dir: string, name: string) => {
        calls.push(name);
        return { succeeded: false, stdout: "phone device\nphone fastboot\n" };
      },
    );
    expect(calls).toEqual(["fastboot-devices", "adb-devices"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown product never authorizes grizzly OEM or shell diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "grizzly-identity-test-"));
  const calls: string[] = [];
  try {
    captureEvidence(
      { device: "phone", outRoot: root },
      (_dir: string, name: string) => {
        calls.push(name);
        return {
          succeeded: true,
          stdout:
            name === "fastboot-devices"
              ? "phone fastboot\n"
              : name === "adb-devices"
                ? "phone device\n"
                : name === "fastboot-product"
                  ? "product: other\n"
                  : "other\n",
        };
      },
    );
    expect(calls).toEqual([
      "fastboot-devices",
      "adb-devices",
      "fastboot-product",
      "adb-product",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real subprocess stderr reaches device identity checks and failures stay failures", () => {
  const root = mkdtempSync(join(tmpdir(), "grizzly-stderr-"));
  try {
    const result = capture(root, "product", process.execPath, [
      "-e",
      'process.stderr.write("(bootloader) product: grizzly\\n")',
    ]);
    expect(result.succeeded).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("product: grizzly");
    expect(readFileSync(join(root, "product.txt"), "utf8")).toContain(
      result.stderr,
    );
    const out = captureEvidence(
      { device: "phone", outRoot: root },
      (_dir, name) => {
        if (name === "fastboot-devices")
          return { succeeded: true, stdout: "phone fastboot\n" };
        if (name === "adb-devices") return { succeeded: true, stdout: "" };
        if (name === "fastboot-product") return result;
        return { succeeded: true, stdout: "" };
      },
    );
    expect(
      JSON.parse(readFileSync(join(out, "device-identity.json"), "utf8"))
        .grizzlyFastboot,
    ).toBe(true);
    const failed = capture(root, "failed-product", process.execPath, [
      "-e",
      'process.stderr.write("product: grizzly\\n"); process.exit(1)',
    ]);
    expect(failed.succeeded).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
