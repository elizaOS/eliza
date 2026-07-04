/** Exercises capacitor ios boot eval guard behavior with deterministic app-core test fixtures. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Boot-time "⚡️  JS Eval error A JavaScript exception occurred" guard
 * (issue #11030, leg C).
 *
 * Root cause: `CapacitorBridge.setupCordovaCompatibility()` registers a
 * `UIApplication.willEnterForegroundNotification` observer that evals
 * `window.Capacitor.triggerEvent('resume', 'document')`. With a UIScene-based
 * lifecycle (this app ships `SceneDelegate.swift`), that notification ALSO
 * fires at cold launch — before the WKWebView has committed the initial page,
 * so `window.Capacitor` is undefined and the eval throws
 * WKError.javaScriptExceptionOccurred, printing the scary boot-time
 * "JS Eval error" line on every real-device launch.
 *
 * The fix is `patches/@capacitor%2Fios@<version>.patch`: both the "resume"
 * and "pause" document-event observers are gated on the bridge's
 * `webViewDelegationHandler.webViewLoadingState == .subsequentLoad` (i.e. the
 * initial load finished at least once). This suite pins the patch so it
 * cannot be silently dropped:
 *
 *  - the patch must stay registered in root package.json + bun.lock for the
 *    EXACT `@capacitor/ios` version packages/app declares (bumping the
 *    dependency without carrying the patch forward turns this suite red);
 *  - the patch content must keep guarding BOTH observers;
 *  - patches/CHECKSUMS.sha256 must match the patch bytes (verify-patches CI);
 *  - when the installed node_modules copy matches the declared version, its
 *    CapacitorBridge.swift must actually contain the guard (proves bun
 *    applied the patch, not just registered it).
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const GUARD_LINE =
  "guard let self = self, case .subsequentLoad = self.webViewDelegationHandler.webViewLoadingState else {";

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
}

const appPackageJson = readJson("packages/app/package.json") as {
  dependencies?: Record<string, string>;
};
const declaredVersion = appPackageJson.dependencies?.["@capacitor/ios"] ?? "";

const patchKey = `@capacitor/ios@${declaredVersion}`;
const patchRelPath = `patches/@capacitor%2Fios@${declaredVersion}.patch`;
const patchAbsPath = path.join(REPO_ROOT, patchRelPath);

// bun may hoist @capacitor/ios to the root node_modules or leave it under the
// consuming package (packages/app) depending on the tree — check both.
const installedPackageRoot = [
  path.join(REPO_ROOT, "node_modules", "@capacitor", "ios"),
  path.join(REPO_ROOT, "packages", "app", "node_modules", "@capacitor", "ios"),
].find((candidate) => existsSync(path.join(candidate, "package.json")));
const installedVersion = installedPackageRoot
  ? (
      JSON.parse(
        readFileSync(path.join(installedPackageRoot, "package.json"), "utf8"),
      ) as {
        version: string;
      }
    ).version
  : "";

describe("@capacitor/ios boot-time resume/pause eval guard (issue #11030)", () => {
  it("packages/app pins an exact @capacitor/ios version", () => {
    expect(
      declaredVersion,
      "packages/app must declare @capacitor/ios",
    ).not.toBe("");
    expect(
      /^\d+\.\d+\.\d+$/.test(declaredVersion),
      `@capacitor/ios must be pinned exactly (got "${declaredVersion}") so the ` +
        "boot-eval patch below can target it deterministically",
    ).toBe(true);
  });

  it("root package.json registers the patch for the declared version", () => {
    const rootPackageJson = readJson("package.json") as {
      patchedDependencies?: Record<string, string>;
    };
    expect(
      rootPackageJson.patchedDependencies?.[patchKey],
      `package.json patchedDependencies must map "${patchKey}" -> ` +
        `"${patchRelPath}". If @capacitor/ios was bumped, regenerate the patch ` +
        "for the new version (the resume/pause cold-launch guard in " +
        "CapacitorBridge.setupCordovaCompatibility) and re-register it — " +
        "dropping it re-introduces the boot-time 'JS Eval error' on iOS devices.",
    ).toBe(patchRelPath);
  });

  it("bun.lock carries the same patchedDependencies entry", () => {
    const lock = readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8");
    expect(
      lock.includes(`"${patchKey}": "${patchRelPath}"`),
      `bun.lock patchedDependencies must include "${patchKey}": "${patchRelPath}" ` +
        "(run bun install after changing package.json patchedDependencies)",
    ).toBe(true);
  });

  it("the patch guards BOTH the resume and pause document-event evals", () => {
    expect(existsSync(patchAbsPath), `${patchRelPath} must exist`).toBe(true);
    const patch = readFileSync(patchAbsPath, "utf8");

    expect(patch).toContain(
      "diff --git a/Capacitor/Capacitor/CapacitorBridge.swift b/Capacitor/Capacitor/CapacitorBridge.swift",
    );

    // Both unguarded evals removed…
    expect(patch).toContain(
      `-                self?.triggerDocumentJSEvent(eventName: "resume")`,
    );
    expect(patch).toContain(
      `-                self?.triggerDocumentJSEvent(eventName: "pause")`,
    );

    // …and replaced by loading-state-gated versions.
    const addedGuards = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && line.includes(GUARD_LINE));
    expect(
      addedGuards.length,
      "the patch must add the webViewLoadingState guard to both the resume " +
        "and pause observers",
    ).toBe(2);
    expect(patch).toContain(
      `+                self.triggerDocumentJSEvent(eventName: "resume")`,
    );
    expect(patch).toContain(
      `+                self.triggerDocumentJSEvent(eventName: "pause")`,
    );
  });

  it("patches/CHECKSUMS.sha256 matches the patch bytes", () => {
    const checksums = readFileSync(
      path.join(REPO_ROOT, "patches", "CHECKSUMS.sha256"),
      "utf8",
    );
    const entry = checksums
      .split("\n")
      .find((line) =>
        line.endsWith(`./@capacitor%2Fios@${declaredVersion}.patch`),
      );
    expect(
      entry,
      "patches/CHECKSUMS.sha256 must list the @capacitor/ios patch " +
        "(run scripts/security/verify-patches.sh --generate)",
    ).toBeDefined();
    const recordedHash = (entry ?? "").split(/\s+/)[0];
    const actualHash = createHash("sha256")
      .update(readFileSync(patchAbsPath))
      .digest("hex");
    expect(recordedHash).toBe(actualHash);
  });

  // On a machine with a stale node_modules (installed @capacitor/ios older
  // than the declared version) this check cannot run — the visible skip keeps
  // it from passing vacuously. On CI, bun install always syncs the version,
  // so the applied-patch assertion executes there.
  it.skipIf(installedVersion !== declaredVersion)(
    "the installed @capacitor/ios copy actually contains the guard",
    () => {
      const bridgeSource = readFileSync(
        path.join(
          installedPackageRoot ?? "",
          "Capacitor",
          "Capacitor",
          "CapacitorBridge.swift",
        ),
        "utf8",
      );
      const guardCount = bridgeSource
        .split("\n")
        .filter((line) => line.includes(GUARD_LINE)).length;
      expect(
        guardCount,
        "the installed @capacitor/ios Capacitor/Capacitor/CapacitorBridge.swift " +
          "must carry the resume+pause cold-launch guard — bun install did not " +
          "apply patches/@capacitor%2Fios patch",
      ).toBe(2);
    },
  );
});
