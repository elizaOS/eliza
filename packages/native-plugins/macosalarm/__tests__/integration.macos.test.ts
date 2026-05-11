import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHelper } from "../src/helper";

// requires.os: "macos"
//
// Builds the Swift helper with swiftc and invokes it end-to-end. Skipped on
// non-darwin so CI on other OSes stays green.
//
// Note: UNUserNotificationCenter requires the binary to live inside a signed
// app bundle at runtime. Invoked as a bare CLI, it throws
// NSInternalInconsistencyException about `bundleProxyForCurrentProcess is
// nil`. Packaging/signing is owned by eliza-devops (deferred per T8b); this
// test therefore asserts the helper builds and runs, and accepts the known
// bundle-proxy error as a documented "unbundled" signal.

const isMac = process.platform === "darwin";
const suite = isMac ? describe : describe.skip;

suite("macosalarm helper (darwin integration)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, "..");
  const source = resolve(pkgRoot, "swift-helper", "main.swift");
  const outDir = mkdtempSync(resolve(tmpdir(), "macosalarm-"));
  const bin = resolve(outDir, "macosalarm-helper");

  it("builds with swiftc", () => {
    expect(existsSync(source)).toBe(true);
    const result = spawnSync("swiftc", [source, "-o", bin], {
      stdio: "inherit",
    });
    expect(result.status).toBe(0);
    expect(existsSync(bin)).toBe(true);
  }, 30_000);

  it("invokes the helper (structured response or unbundled bundle-proxy)", async () => {
    let observed: { success: boolean } | null = null;
    let observedError: Error | null = null;

    try {
      const resp = await runHelper(
        { action: "permission" },
        { binPathOverride: bin, timeoutMs: 10_000 },
      );
      observed = resp;
    } catch (err) {
      observedError = err as Error;
    }

    if (observed) {
      expect(typeof observed.success).toBe("boolean");
      return;
    }

    // Accept the known-unbundled failure so the test is meaningful on a dev
    // machine without an app bundle. Packaging is deferred.
    expect(observedError).not.toBeNull();
    expect(observedError!.message).toMatch(/bundleProxyForCurrentProcess/);
  }, 30_000);
});
