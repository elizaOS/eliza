/** Owns Capacitor platform synchronization and complete renderer payload mirroring using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertStagedRendererMatchesBuild,
  overlayFreshRendererIntoPublic,
} from "../lib/renderer-build-manifest.mjs";
import {
  dropRetiredLlamaCppFromAndroidGradle,
  reconcilePluginManifestWithGradle,
} from "./android/gradle-reconciliation.mjs";
import {
  isCapacitorPlatformReady,
  rmRecursive,
  runCapacitor,
  syncPlatformTemplateFiles,
} from "./build-tools.mjs";
import {
  androidDir,
  appDir,
  elizaRepoRoot,
  iosDir,
  repoRoot,
} from "./context.mjs";

// ── Phase 3: Capacitor sync ────────────────────────────────────────────

export async function ensurePlatform(platform, { env = process.env } = {}) {
  const dir = platform === "android" ? androidDir : iosDir;
  if (!fs.existsSync(dir)) {
    const copied = syncPlatformTemplateFiles(platform);
    if (copied.length === 0) {
      console.log(`[mobile-build] Adding Capacitor ${platform} platform...`);
      await runCapacitor(["add", platform], { env });
    }
  }
  if (!isCapacitorPlatformReady(platform)) {
    syncPlatformTemplateFiles(platform);
  }
}

/**
 * `cap sync android` copies the web bundle + capacitor runtime config into the
 * host app's Capacitor project (`<appDir>/android`). The gradle build and agent
 * staging, however, run against the canonical platform tree
 * (`androidDir` = `app-core/platforms/android`). When those are distinct
 * directories — e.g. this elizaOS checkout nested inside a consumer monorepo —
 * the freshly-synced renderer never reaches the dir gradle packages, so the APK
 * ships no web assets and the WebView 404s on index.html
 * (net::ERR_CONNECTION_REFUSED). Mirror the synced payload into androidDir.
 * No-op when both trees resolve to the same directory (standalone layout) or
 * when the synced public payload is missing.
 */
// `@elizaos/capacitor-bun-runtime` is an app-core-only native module (it powers
// the on-device Bun agent runtime) and is NOT a `packages/app` dependency, so
// `cap sync` never emits it. Now that `android.path` makes cap sync regenerate
// capacitor.settings.gradle / capacitor.build.gradle in place, those files would
// lose bun-runtime on every sync. Re-register it idempotently after each sync so
// the on-device agent keeps building (exact module name + projectDir the
// committed files used).
export function ensureBunRuntimeRegistered() {
  const MODULE = "elizaos-capacitor-bun-runtime";
  // Resolve the projectDir relative to the ACTUAL androidDir, not a hardcoded
  // `../../../../` that only happens to be right for the eliza tree's depth
  // (`app-core/platforms/android`). A white-label consumer building in
  // `apps/app/android` (ELIZA_ANDROID_USE_APP_DIR=1) sits at a different depth,
  // so the hardcoded path resolved to a non-existent dir and gradle aborted
  // ("projectDirectory … does not exist"). path.relative gives the correct
  // hops from either androidDir to the bun-runtime plugin in the eliza checkout.
  const PROJECT_DIR = path
    .relative(
      androidDir,
      path.join(
        elizaRepoRoot,
        "plugins",
        "plugin-native-bun-runtime",
        "android",
      ),
    )
    .split(path.sep)
    .join("/");
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  const buildGradlePath = path.join(
    androidDir,
    "app",
    "capacitor.build.gradle",
  );

  if (fs.existsSync(settingsPath)) {
    let settings = fs.readFileSync(settingsPath, "utf8");
    if (!settings.includes(`':${MODULE}'`)) {
      settings = `${settings.trimEnd()}\ninclude ':${MODULE}'\nproject(':${MODULE}').projectDir = new File('${PROJECT_DIR}')\n`;
      fs.writeFileSync(settingsPath, settings);
      console.log(
        `[mobile-build] Re-registered ${MODULE} (cap sync omits this app-core-only module).`,
      );
    }
  }

  if (fs.existsSync(buildGradlePath)) {
    let build = fs.readFileSync(buildGradlePath, "utf8");
    if (!build.includes(`project(':${MODULE}')`)) {
      build = build.replace(
        /dependencies\s*\{/,
        `dependencies {\n    implementation project(':${MODULE}')`,
      );
      fs.writeFileSync(buildGradlePath, build);
    }
  }
}

export function mirrorCapacitorWebPayloadIntoAndroidDir() {
  const syncedAssets = path.join(
    appDir,
    "android",
    "app",
    "src",
    "main",
    "assets",
  );
  const targetAssets = path.join(androidDir, "app", "src", "main", "assets");
  const targetPublic = path.join(targetAssets, "public");
  const syncedPublic = path.join(syncedAssets, "public");
  // Mirror the synced web payload only when cap sync wrote to a SEPARATE appDir
  // tree (the legacy two-tree split). When capacitor.config.ts unifies the trees
  // via android.path=../app-core/platforms/android (#8387), cap sync writes
  // straight into androidDir, so there's no syncedPublic to copy (or it's the
  // same tree). In that case the mirror is a no-op — but we MUST still run the
  // reconcile below on the android manifest, so the early-returns only skip the
  // copy, never the reconcile.
  const hasSyncedPublic = fs.existsSync(syncedPublic);
  const sameTree =
    hasSyncedPublic &&
    fs.existsSync(targetAssets) &&
    fs.realpathSync(syncedAssets) === fs.realpathSync(targetAssets);
  // STALE-MIRROR GUARD: with the unified tree (android.path =
  // ../app-core/platforms/android, #8387) cap sync writes the fresh
  // capacitor.plugins.json straight into androidDir — but a leftover legacy
  // appDir/android tree (with its own assets/public) makes hasSyncedPublic
  // true and !sameTree, so this mirror used to STOMP the freshly synced
  // manifest with a months-old copy. That silently dropped every
  // newer native plugin (ML Kit OCR, ScreenCapture, mobile-agent-bridge, …)
  // from auto-registration: "not implemented on android" at runtime
  // (verified live on emulator-5554). Only mirror when the synced manifest is
  // at least as fresh as the target's.
  const syncedManifest = path.join(syncedAssets, "capacitor.plugins.json");
  const targetManifest = path.join(targetAssets, "capacitor.plugins.json");
  const syncedIsStale =
    fs.existsSync(syncedManifest) &&
    fs.existsSync(targetManifest) &&
    fs.statSync(syncedManifest).mtimeMs < fs.statSync(targetManifest).mtimeMs;
  if (syncedIsStale && !sameTree) {
    console.log(
      `[mobile-build] Skipping Capacitor web-payload mirror: ${path.relative(repoRoot, syncedAssets)} is a stale legacy tree (its capacitor.plugins.json is older than the freshly synced ${path.relative(repoRoot, targetManifest)}).`,
    );
  }
  if (hasSyncedPublic && !sameTree && !syncedIsStale) {
    fs.mkdirSync(targetAssets, { recursive: true });
    rmRecursive(targetPublic);
    fs.cpSync(syncedPublic, targetPublic, { recursive: true });
    for (const cfg of ["capacitor.config.json", "capacitor.plugins.json"]) {
      const src = path.join(syncedAssets, cfg);
      if (fs.existsSync(src))
        fs.copyFileSync(src, path.join(targetAssets, cfg));
    }
    console.log(
      `[mobile-build] Mirrored Capacitor web payload into ${path.relative(repoRoot, targetAssets)}`,
    );
  }
  // `cap sync` generates capacitor.plugins.json from the
  // FULL appDir dependency set, but androidDir ships a committed
  // capacitor.settings.gradle that compiles only a curated subset of plugin
  // modules (plus app-core additions like elizaos-capacitor-bun-runtime that
  // cap sync never emits). Mirroring the full manifest into androidDir leaves
  // it listing classes that aren't on the dex — and Capacitor's
  // PluginManager.loadPluginClasses ABORTS the ENTIRE auto-registration on the
  // first missing class (PluginLoadException). The net effect is that NONE of
  // the auto-registered plugins load — including the compiled ones the app
  // actually needs (Preferences, LlamaCpp, every @elizaos/capacitor-*) — so
  // on-device local inference and Capacitor Preferences silently report
  // "not implemented on android". Reconcile the manifest with what gradle
  // actually compiles so loadPluginClasses succeeds.
  // STALE-WEB GUARD: cap sync (even unified via android.path) has been observed
  // to leave a STALE assets/public — an old entry hash in the gradle-packaged
  // tree, shipping an "ancient" UI despite a fresh build. The freshly vite-built
  // bundle in appDir/dist is the source of truth, so overlay it unconditionally:
  // clear the hashed assets/ then copy dist over public. cordova.js /
  // cordova_plugins.js are Capacitor-injected (NOT in dist) and survive because
  // we only clear assets/ and cpSync never deletes existing non-dist files;
  // capacitor.config.json / capacitor.plugins.json live in targetAssets (above
  // public) and are untouched.
  const freshWeb = path.join(appDir, "dist");
  if (
    fs.existsSync(path.join(freshWeb, "index.html")) &&
    fs.existsSync(targetAssets)
  ) {
    fs.mkdirSync(targetPublic, { recursive: true });
    rmRecursive(path.join(targetPublic, "assets"));
    fs.cpSync(freshWeb, targetPublic, { recursive: true });
    console.log(
      `[mobile-build] Stale-web guard: overlaid fresh ${path.relative(repoRoot, freshWeb)} → ${path.relative(repoRoot, targetPublic)}`,
    );
  }
  dropRetiredLlamaCppFromAndroidGradle();
  reconcilePluginManifestWithGradle(targetAssets);
  // Verify the staged Android renderer is exactly the freshly built one. The
  // overlay above makes it so; this turns "should be fresh" into a hard,
  // build-failing guarantee (issue #9309).
  if (fs.existsSync(path.join(freshWeb, "index.html"))) {
    assertStagedRendererMatchesBuild(freshWeb, targetPublic, {
      label: "android",
    });
  }
}

/**
 * iOS stale-web guard — the iOS counterpart to
 * mirrorCapacitorWebPayloadIntoAndroidDir. `cap sync ios` (and a skipped sync)
 * have both been observed to leave a STALE `ios/App/App/public` — an old entry
 * hash shipping an ancient UI despite a fresh `dist`. The freshly vite-built
 * bundle is the source of truth, so overlay it unconditionally: clear the hashed
 * assets/ then copy dist over public. The on-device agent payload
 * (`public/agent`) and PGlite root extension assets staged by
 * stageIosAgentRuntime live OUTSIDE dist and survive — we only clear
 * `public/assets` and cpSync never deletes existing non-dist files. After the
 * overlay we assert the staged renderer matches the build so a stale/missing UI
 * FAILS THE BUILD instead of shipping (issue #9309).
 */
export function mirrorCapacitorWebPayloadIntoIosDir() {
  const freshWeb = path.join(appDir, "dist");
  const targetPublic = path.join(iosDir, "App", "public");
  overlayFreshRendererIntoPublic(freshWeb, targetPublic, { label: "ios" });
  console.log(
    `[mobile-build] Stale-web guard: overlaid fresh ${path.relative(repoRoot, freshWeb)} → ${path.relative(repoRoot, targetPublic)}`,
  );
}
