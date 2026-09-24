/** Owns artifact inspection provenance using the shared build context and existing platform contracts. */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packagedRuntimeFiles } from "../../lib/apk-runtime-provenance.mjs";
import { RUNTIME_PROVENANCE_FILENAME } from "../../lib/stage-android-agent.mjs";
import { rmRecursive, runCaptureSync } from "../build-tools.mjs";
import {
  APP,
  androidDir,
  androidSmsGatewayDebugApkArtifact,
  elizaOsApkDir,
  elizaOsApkName,
  localArtifactsDir,
  repoRoot,
} from "../context.mjs";
import { firstExisting, resolveExecutable } from "../toolchain.mjs";

export function preserveAndroidSmsGatewayArtifact(artifact) {
  fs.mkdirSync(localArtifactsDir, { recursive: true });
  fs.copyFileSync(artifact, androidSmsGatewayDebugApkArtifact);
  console.log(
    `[mobile-build] android-sms-gateway preserved APK: ${androidSmsGatewayDebugApkArtifact}`,
  );
}

export function findAndroidSystemApk() {
  // Release-only. Staging a debug APK ships without R8 shrinking and
  // bypasses the release signing config — both invariants the AOSP
  // prebuilt path assumes hold. Soong re-signs with the platform key
  // either way, so a debug fallback is never an acceptable substitute.
  const candidates = [
    path.join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "release",
      "app-release-unsigned.apk",
    ),
    path.join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "release",
      "app-release.apk",
    ),
  ];
  return firstExisting(candidates);
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function currentGitRevision() {
  const result = runCaptureSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function writeAndroidSystemProvenance(apkPath) {
  const zip = resolveExecutable("zip");
  if (!zip) {
    throw new Error(
      "[mobile-build] zip not found on PATH; cannot embed AOSP APK provenance metadata.",
    );
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-aosp-apk-"));
  try {
    const rel = path.join("META-INF", "eliza", "aosp-build-provenance.json");
    const target = path.join(tmpDir, rel);
    const runtimeProvenancePath = path.join(
      androidDir,
      "app",
      "src",
      "main",
      "assets",
      "agent",
      RUNTIME_PROVENANCE_FILENAME,
    );
    const runtimeProvenance = fs.existsSync(runtimeProvenancePath)
      ? JSON.parse(fs.readFileSync(runtimeProvenancePath, "utf8"))
      : null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        {
          schema: "eliza.aosp_build_provenance.v1",
          staged_at: new Date().toISOString(),
          repo_root: ".",
          repo_root_provenance: "relative_to_git_checkout",
          git_revision: currentGitRevision(),
          apk_name: path.basename(apkPath),
          apk_sha256_before_provenance: sha256File(apkPath),
          runtime_provenance_entry: `assets/agent/${RUNTIME_PROVENANCE_FILENAME}`,
          runtime_provenance_sha256: runtimeProvenance
            ? sha256File(runtimeProvenancePath)
            : null,
          runtime_provenance: runtimeProvenance,
          runtime_provenance_stage: "pre_gradle_inputs",
          packaged_runtime_files: packagedRuntimeFiles(apkPath),
          android_system_variant: APP.appName,
          android_package: APP.appId,
          claim_boundary:
            "apk_packaging_provenance_only_not_aosp_boot_or_gui_runtime_evidence",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = spawnSync(zip, ["-q", "-X", apkPath, rel], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `[mobile-build] Failed to embed AOSP APK provenance: ${
          result.stderr || result.stdout || `zip exited with ${result.status}`
        }`,
      );
    }
  } finally {
    rmRecursive(tmpDir);
  }
}

export function stageAndroidSystemApk() {
  const apk = findAndroidSystemApk();
  if (!apk) {
    throw new Error(
      "No release APK found at app/build/outputs/apk/release/. Run :app:assembleRelease before staging the ElizaOS prebuilt — debug APKs are not accepted.",
    );
  }
  fs.mkdirSync(elizaOsApkDir, { recursive: true });
  const target = path.join(elizaOsApkDir, elizaOsApkName);
  fs.copyFileSync(apk, target);
  writeAndroidSystemProvenance(target);
  console.log(`[mobile-build] Staged ${elizaOsApkName} at ${target}.`);
}
