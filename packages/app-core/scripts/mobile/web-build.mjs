/** Owns mobile renderer build and lane-specific artifact reuse validation using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  androidRuntimeEnvOverrideMismatches,
  evaluateIosLocalLaneRuntime,
  rendererLaneStampMismatches,
  resolveExpectedRendererStamp,
} from "../lib/mobile-lane-stamp.mjs";
import {
  mobileRendererRequiresFreshBuild,
  mobileRendererUnstampedFeatureProblem,
  resolveMobileRendererFeatureEnv,
} from "../lib/mobile-renderer-feature-env.mjs";
import {
  formatMobileWebDistProblems,
  mobileWebDistReuseStatus,
} from "../lib/mobile-web-build-reuse.mjs";
import { readRendererBuildManifest } from "../lib/renderer-build-manifest.mjs";
import {
  resolveViteCli,
  run,
  withMobileBuildNodeOptions,
} from "./build-tools.mjs";
import { appDir, packagesRoot, repoRoot } from "./context.mjs";
import {
  isFullIosBunEngineRequested,
  shouldIncludeIosFullBunEngine,
} from "./ios/policy.mjs";
import { resolveBunExecutable } from "./toolchain.mjs";

// ── Phase 2: Build web bundle ───────────────────────────────────────────

export function resolveMobileBuildPolicy(platform) {
  const capacitorTarget =
    platform === "android-system" ||
    platform === "android-launcher" ||
    platform === "android-cloud" ||
    platform === "android-cloud-debug" ||
    platform === "android-cloud-hybrid"
      ? "android"
      : platform === "ios-overlay" || platform === "ios-local"
        ? "ios"
        : platform;
  // Android runtime mode mirrors the iOS runtime mode pattern: `cloud`
  // means the renderer should treat Eliza Cloud as the only hosting target
  // (Play-Store-compliant thin client; no on-device agent), while `local`
  // is the default sideload/AOSP behavior. Surfaced to the renderer via
  // VITE_ELIZA_ANDROID_RUNTIME_MODE so it can hide the Local picker option.
  const androidRuntimeMode =
    platform === "android-cloud" ||
    platform === "android-cloud-debug" ||
    platform === "android-launcher"
      ? "cloud"
      : platform === "android-cloud-hybrid"
        ? "cloud-hybrid"
        : platform === "android" || platform === "android-system"
          ? "local"
          : null;
  const iosRuntimeMode =
    platform === "ios-local"
      ? "local"
      : platform === "ios"
        ? "cloud-hybrid"
        : platform === "ios-overlay"
          ? "cloud"
          : null;
  const runtimeExecutionMode =
    platform === "android-cloud" ||
    platform === "android-cloud-debug" ||
    platform === "android-launcher"
      ? "cloud"
      : platform === "android" ||
          platform === "android-system" ||
          platform === "android-cloud-hybrid"
        ? "local-yolo"
        : platform === "ios-local"
          ? "local-safe"
          : platform === "ios"
            ? "local-safe"
            : platform === "ios-overlay"
              ? "cloud"
              : null;
  const buildVariant =
    platform === "android-cloud" || platform === "ios" ? "store" : "direct";
  const releaseAuthority =
    platform === "android-cloud"
      ? "google-play"
      : platform === "android" || platform === "android-cloud-hybrid"
        ? "github-release-android-package-installer"
        : platform === "android-system"
          ? "aosp-ota"
          : platform === "ios"
            ? "apple-app-store"
            : platform === "ios-local"
              ? "developer-toolchain"
              : platform === "android-cloud-debug" ||
                  platform === "android-launcher"
                ? "developer-debug"
                : "developer-toolchain";
  return {
    capacitorTarget,
    buildVariant,
    androidRuntimeMode,
    iosRuntimeMode,
    runtimeExecutionMode,
    releaseAuthority,
    appControlledOta: false,
  };
}

export async function buildWeb(platform) {
  const lanePolicy = resolveMobileBuildPolicy(platform);
  const androidEnvMismatches = androidRuntimeEnvOverrideMismatches({
    platform,
    policy: lanePolicy,
    env: process.env,
  });
  if (androidEnvMismatches.length > 0) {
    throw new Error(
      `[mobile-build] Refusing leaked Android runtime-mode env for target '${platform}':\n` +
        `${formatMobileWebDistProblems(androidEnvMismatches)}\n` +
        `Unset the leaked variable or use the matching Android target.`,
    );
  }
  const laneExpected = resolveExpectedRendererStamp({
    policy: lanePolicy,
    env: process.env,
  });
  // Refuse to even START a renderer build that would bake the #11030 hang
  // combination (ios-local + non-local runtime mode + no Agent.apiBase, which
  // can only happen via a leaked VITE_ELIZA_IOS_RUNTIME_MODE override).
  const laneRule = evaluateIosLocalLaneRuntime({
    platform,
    runtimeMode: laneExpected.runtimeMode,
    env: process.env,
  });
  if (!laneRule.ok) {
    throw new Error(`[mobile-build] ${laneRule.reason}`);
  }
  // Auto-skip the full Vite renderer build when it is NOT explicitly forced and
  // the existing dist is already up-to-date for this variant/target (#9626).
  // This reuses the same manifest + staleness checks as the explicit-skip path
  // below, so the loud-fail-on-stale guarantee is preserved: a stale or
  // mismatched dist simply does not match here and falls through to a rebuild.
  // Explicit ELIZA_MOBILE_SKIP_WEB_BUILD=1 keeps its force-reuse semantics below.
  const requiresFreshRenderer = mobileRendererRequiresFreshBuild({ platform });
  if (
    process.env.ELIZA_MOBILE_SKIP_WEB_BUILD !== "1" &&
    !requiresFreshRenderer
  ) {
    const autoStatus = mobileWebDistReuseStatus({
      appDir,
      repoRoot,
      expectedVariant: laneExpected.variant,
      expectedTarget: laneExpected.capacitorTarget,
      // A dist built for another lane's runtime mode (e.g. a cloud-hybrid
      // bundle left behind by an ios cloud build) must never be reused into
      // this lane — it falls through to a fresh rebuild instead (#11030).
      expectedRuntimeMode: laneExpected.runtimeMode,
      expectedIosApnsEnabled: laneExpected.iosApnsEnabled,
    });
    if (autoStatus.reusable) {
      console.log(
        "[mobile-build] Auto-skipping web build: existing dist is up-to-date " +
          `(buildId=${autoStatus.manifest.buildId.slice(0, 12)})`,
      );
      return;
    }
  }
  if (
    process.env.ELIZA_MOBILE_SKIP_WEB_BUILD !== "1" &&
    requiresFreshRenderer
  ) {
    console.log(
      `[mobile-build] Rebuilding renderer for '${platform}': lane-specific feature flags require fresh output.`,
    );
  }
  if (process.env.ELIZA_MOBILE_SKIP_WEB_BUILD === "1") {
    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot,
      expectedVariant: laneExpected.variant,
      expectedTarget: laneExpected.capacitorTarget,
      expectedRuntimeMode: laneExpected.runtimeMode,
      expectedIosApnsEnabled: laneExpected.iosApnsEnabled,
    });
    if (!fs.existsSync(status.indexPath)) {
      throw new Error(
        `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD=1 but ${status.indexPath} is missing.`,
      );
    }
    // Never SILENTLY reuse a stale renderer (issue #9309). The skip flag is an
    // explicit "reuse the existing dist" request, but it must still fail loudly
    // when that dist is stale relative to sources or was built for a different
    // variant/target than this build needs. A deliberate stale reuse can be
    // forced with ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1.
    const allowStale =
      process.env.ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE === "1";
    const reuseProblems = [...status.problems];
    const unstampedFeatureProblem = mobileRendererUnstampedFeatureProblem({
      platform,
    });
    if (unstampedFeatureProblem) reuseProblems.push(unstampedFeatureProblem);
    if (reuseProblems.length > 0) {
      const detail = formatMobileWebDistProblems(reuseProblems);
      if (!allowStale) {
        throw new Error(
          `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD=1 refused — the existing web build is stale or mismatched:\n${detail}\n` +
            `Drop ELIZA_MOBILE_SKIP_WEB_BUILD to rebuild, or set ` +
            `ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 to ship this dist anyway (NOT recommended).`,
        );
      }
      console.warn(
        `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 — shipping a renderer flagged as stale/mismatched:\n${detail}`,
      );
    }
    console.log(
      `[mobile-build] Reusing existing web build: ${path.relative(repoRoot, status.distDir)}` +
        (status.manifest
          ? ` (buildId=${status.manifest.buildId.slice(0, 12)})`
          : ""),
    );
    return;
  }
  const {
    capacitorTarget,
    buildVariant,
    androidRuntimeMode,
    iosRuntimeMode,
    runtimeExecutionMode,
    releaseAuthority,
  } = lanePolicy;
  const env = withMobileBuildNodeOptions({
    ...process.env,
    ELIZA_CAPACITOR_BUILD_TARGET: capacitorTarget,
    ELIZA_BUILD_VARIANT: process.env.ELIZA_BUILD_VARIANT || buildVariant,
    ELIZA_RELEASE_AUTHORITY:
      process.env.ELIZA_RELEASE_AUTHORITY || releaseAuthority,
    ...(capacitorTarget === "ios"
      ? {
          // Give Vite an explicit normalized value so its `.env*` loading
          // cannot compile a different gate than the native plist overlay.
          VITE_ELIZA_APNS_ENABLED: laneExpected.iosApnsEnabled ? "1" : "0",
        }
      : {}),
    ...(androidRuntimeMode
      ? {
          VITE_ELIZA_ANDROID_RUNTIME_MODE: androidRuntimeMode,
        }
      : {}),
    ...(iosRuntimeMode
      ? {
          ELIZA_IOS_RUNTIME_MODE: iosRuntimeMode,
          // A pre-set VITE_ELIZA_IOS_RUNTIME_MODE (the value Vite bakes into the
          // renderer) wins over the policy default, mirroring ELIZA_BUILD_VARIANT
          // above. Without this, spreading the policy object clobbered an
          // explicitly chosen runtime mode.
          VITE_ELIZA_IOS_RUNTIME_MODE:
            process.env.VITE_ELIZA_IOS_RUNTIME_MODE || iosRuntimeMode,
        }
      : {}),
    ...(runtimeExecutionMode
      ? {
          ELIZA_RUNTIME_MODE: runtimeExecutionMode,
          RUNTIME_MODE: runtimeExecutionMode,
          LOCAL_RUNTIME_MODE: runtimeExecutionMode,
          VITE_ELIZA_RUNTIME_MODE: runtimeExecutionMode,
        }
      : {}),
    ...((platform === "ios" || platform === "ios-local") &&
    shouldIncludeIosFullBunEngine(process.env)
      ? {
          VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
        }
      : {}),
    ...(platform === "ios-local" && isFullIosBunEngineRequested(process.env)
      ? {
          VITE_ELIZA_IOS_FULL_BUN_STRICT: "1",
        }
      : {}),
    ...(fs.existsSync(path.join(repoRoot, "eliza", "package.json"))
      ? {
          ELIZA_FORCE_LOCAL_UPSTREAMS:
            process.env.ELIZA_FORCE_LOCAL_UPSTREAMS ?? "1",
        }
      : {}),
    ...resolveMobileRendererFeatureEnv({ platform, env: process.env }),
  });
  const bun = resolveBunExecutable();
  const packageStylesPatch = path.join(
    repoRoot,
    "scripts",
    "patch-elizaos-package-styles.mjs",
  );
  if (fs.existsSync(packageStylesPatch)) {
    await run(process.execPath, [packageStylesPatch], { cwd: repoRoot, env });
  }
  if (bun) {
    const sharedEntry = path.join(packagesRoot, "shared", "dist", "index.js");
    if (!fs.existsSync(sharedEntry)) {
      console.log(
        "[mobile-build] Building workspace dependencies for mobile web bundle.",
      );
      await run(bun, ["run", "dev:prepare"], { cwd: repoRoot, env });
    }
    await run(bun, ["run", "build:web"], { cwd: appDir, env });
    return;
  }
  await run(process.execPath, [resolveViteCli(), "build"], {
    cwd: appDir,
    env,
  });
}

/**
 * Lane guard (#11030): assert packages/app/dist carries EXACTLY the renderer
 * stamp this lane bakes, immediately before Capacitor sync copies it into the
 * native project. Between buildWeb() and cap sync there is a window (agent
 * bundle build, CocoaPods, platform templating) in which another lane's build
 * can overwrite dist — that is how a cloud/store renderer left behind by
 * `install:ios:cloud:sideload` was baked into every later `build:ios:local`
 * artifact and hung real devices at "Booting up…".
 *
 * On mismatch the renderer is REBUILT for this lane (buildWeb already knows
 * how); a mismatched bundle is never staged silently. The explicit
 * ELIZA_MOBILE_SKIP_WEB_BUILD=1 + ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1
 * escape hatch keeps its ship-anyway semantics for variant/target/staleness,
 * but the known-broken ios-local hang combination (non-local runtime mode
 * with no Agent.apiBase) stays a hard failure even then — that bundle is not
 * merely stale, it cannot boot on a device.
 */
export async function ensureRendererDistMatchesLane(platform) {
  const policy = resolveMobileBuildPolicy(platform);
  const androidEnvMismatches = androidRuntimeEnvOverrideMismatches({
    platform,
    policy,
    env: process.env,
  });
  if (androidEnvMismatches.length > 0) {
    throw new Error(
      `[mobile-build] Refusing leaked Android runtime-mode env before Capacitor sync for target '${platform}':\n` +
        `${formatMobileWebDistProblems(androidEnvMismatches)}\n` +
        `Unset the leaked variable or use the matching Android target.`,
    );
  }
  const expected = resolveExpectedRendererStamp({
    policy,
    env: process.env,
  });
  const distDir = path.join(appDir, "dist");
  let manifest = readRendererBuildManifest(distDir);
  let mismatches = rendererLaneStampMismatches(manifest, expected);
  if (mismatches.length > 0) {
    const detail = formatMobileWebDistProblems(mismatches);
    const skipWebBuild = process.env.ELIZA_MOBILE_SKIP_WEB_BUILD === "1";
    const allowStale =
      skipWebBuild &&
      process.env.ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE === "1";
    if (allowStale) {
      console.warn(
        `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 — staging a renderer that does not match the '${platform}' lane:\n${detail}`,
      );
    } else if (skipWebBuild) {
      throw new Error(
        `[mobile-build] refusing to stage packages/app/dist into the native project — it was not built for the '${platform}' lane:\n${detail}\n` +
          `Drop ELIZA_MOBILE_SKIP_WEB_BUILD to rebuild for this lane, or set ` +
          `ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 to ship it anyway (NOT recommended).`,
      );
    } else {
      console.warn(
        `[mobile-build] packages/app/dist does not match the '${platform}' lane — rebuilding the renderer for this lane instead of staging a wrong-lane bundle (#11030):\n${detail}`,
      );
      await buildWeb(platform);
      manifest = readRendererBuildManifest(distDir);
      mismatches = rendererLaneStampMismatches(manifest, expected);
      if (mismatches.length > 0) {
        throw new Error(
          `[mobile-build] packages/app/dist still does not match the '${platform}' lane after a rebuild:\n${formatMobileWebDistProblems(mismatches)}\n` +
            `An env override (ELIZA_BUILD_VARIANT / VITE_ELIZA_IOS_RUNTIME_MODE / VITE_ELIZA_ANDROID_RUNTIME_MODE / ELIZA_RUNTIME_MODE) ` +
            `is forcing a different stamp than this lane expects — unset it or use the matching build lane.`,
        );
      }
    }
  }
  // Hard #11030 rule on the ACTUAL bundle about to be staged — applies even
  // under the ALLOW_STALE escape hatch (a cloud-mode ios-local bundle with no
  // endpoint is known-broken on device, not merely stale).
  const distRule = evaluateIosLocalLaneRuntime({
    platform,
    runtimeMode: manifest?.runtimeMode ?? null,
    env: process.env,
  });
  if (!distRule.ok) {
    throw new Error(
      `[mobile-build] refusing to stage packages/app/dist into the native project: ${distRule.reason}`,
    );
  }
}
