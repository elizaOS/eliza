/**
 * The OS test fingerprint and the Android toolchain that actually ran: a
 * fingerprint is recorded only while a complete toolchain is installed, it
 * changes when any part of that toolchain changes, and it comes back when the
 * toolchain is restored, so a pass recorded against one SDK cannot be reused
 * after the SDK moves.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { testInputs } from "../../util.ts";

const root = path.resolve(import.meta.dirname, "../../..");

/** A fresh copy of the fixture package, with `overlay` over it. */
function fixture(name: string, overlay?: string) {
  const dir = path.join(import.meta.dirname, ".cache", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(import.meta.dirname, "fixture/good"), dir, { recursive: true });
  if (overlay) fs.cpSync(path.join(import.meta.dirname, "fixture", overlay), dir, { recursive: true });
  return dir;
}

describe("Android toolchain fingerprints", () => {
  it("keys the OS test fingerprint to the Android toolchain that actually ran", () => {
    const dir = fixture("android-toolchain");
    fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(dir, "pnpm-lock.yaml"));
    const json = path.join(dir, "package.json");
    const osManifest = JSON.parse(fs.readFileSync(json, "utf8")) as { name?: string };
    osManifest.name = "@elizaos/os";
    fs.writeFileSync(json, `${JSON.stringify(osManifest, null, 2)}\n`);
    const controlDir = fixture("android-toolchain-control");
    fs.copyFileSync(path.join(root, "pnpm-lock.yaml"), path.join(controlDir, "pnpm-lock.yaml"));
    const home = fs.mkdtempSync(path.join(tmpdir(), "vibestack-home-"));
    const bin = fs.mkdtempSync(path.join(tmpdir(), "vibestack-bin-"));
    const sdk = path.join(home, "sdk");
    const aapt = path.join(sdk, "build-tools", "36.0.0", "aapt");
    const tools = ["aapt", "aapt2", "apksigner", "zipalign"].map((tool) =>
      path.join("build-tools", "36.0.0", tool),
    );
    const install = () => {
      for (const file of [...tools, path.join("platforms", "android-36", "android.jar")]) {
        const at = path.join(sdk, file);
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.writeFileSync(at, `${file}\n`);
      }
    };
    const saved: Record<string, string | undefined> = {
      ANDROID_HOME: process.env.ANDROID_HOME,
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
      JAVA_HOME: process.env.JAVA_HOME,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      QUINT_HOME: process.env.QUINT_HOME,
    };
    try {
      // Keep the evaluator where it was, so moving HOME below cannot hide it.
      process.env.QUINT_HOME =
        process.env.QUINT_HOME ?? path.join(homedir(), ".quint");
      process.env.HOME = home;
      delete process.env.ANDROID_HOME;
      delete process.env.ANDROID_SDK_ROOT;
      delete process.env.JAVA_HOME;
      for (const name of ["java", "keytool"]) {
        const stub = path.join(bin, name);
        fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(stub, 0o755);
      }
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
      // Cold: with no toolchain anywhere the OS tests would look, the OS
      // tests record no fingerprint, so no pass can be reused for them.
      expect(testInputs(dir)).toBeUndefined();
      const control = testInputs(controlDir);
      expect(control ?? "").toMatch(/^[0-9a-f]{64}$/);
      // Cold install: installing the toolchain records a fingerprint, and a
      // warm repeat of the same toolchain records the same one.
      install();
      process.env.ANDROID_HOME = sdk;
      const cold = testInputs(dir);
      expect(cold ?? "").toMatch(/^[0-9a-f]{64}$/);
      expect(testInputs(dir)).toBe(cold);
      expect(testInputs(controlDir)).toBe(control);
      // Same-path installation: removing and reinstalling the same bytes at
      // the same path records the same fingerprint again.
      fs.rmSync(sdk, { force: true, recursive: true });
      install();
      expect(testInputs(dir)).toBe(cold);
      // Replacement: changing one build tool records a different fingerprint.
      const original = fs.readFileSync(aapt);
      fs.writeFileSync(aapt, "replaced\n");
      const replaced = testInputs(dir);
      expect(replaced ?? "").toMatch(/^[0-9a-f]{64}$/);
      expect(replaced).not.toBe(cold);
      // Restoration: restoring the replaced bytes records the cold fingerprint.
      fs.writeFileSync(aapt, original);
      expect(testInputs(dir)).toBe(cold);
      // Removal: with the SDK gone, no fingerprint is recorded again.
      fs.rmSync(sdk, { force: true, recursive: true });
      expect(testInputs(dir)).toBeUndefined();
      expect(testInputs(controlDir)).toBe(control);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { force: true, recursive: true });
      fs.rmSync(bin, { force: true, recursive: true });
    }
  });
});
