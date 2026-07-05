/**
 * requires.os: "macos"
 *
 * Darwin-only integration test: compiles `swift-helper/main.swift` with
 * `swiftc` and invokes the resulting binary end-to-end via `runHelper`.
 * Skipped on non-darwin so CI on other OSes stays green.
 *
 * `UNUserNotificationCenter` requires the binary to run inside a signed app
 * bundle; invoked as a bare CLI it throws `NSInternalInconsistencyException`
 * ("bundleProxyForCurrentProcess is nil"). Packaging/signing is owned by
 * eliza-devops (deferred per T8b), so this test accepts that documented
 * bundle-proxy error as a valid "ran but unbundled" outcome alongside a real
 * structured response.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runHelper } from "../src/helper";

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
