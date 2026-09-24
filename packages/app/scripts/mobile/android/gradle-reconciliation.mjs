/** Owns android gradle reconciliation using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { androidDir } from "../context.mjs";

/**
 * Remove the RETIRED llama-cpp-capacitor Android module from the gradle build
 * entirely — the `include ':llama-cpp-capacitor'` + project line in
 * capacitor.settings.gradle and the `implementation project(':llama-cpp-capacitor')`
 * in app/capacitor.build.gradle. `cap sync` re-adds these on every sync because
 * the package ships an android/ dir, but agent inference runs solely through the
 * fused libelizainference.so and nothing on Android loads this plugin's separate
 * libllama-cpp-arm64.so. Leaving the gradle project in only made gradle configure
 * its CMake — which built a no-op stub and used to require the
 * ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB opt-out. Dropping the project removes the
 * stub build outright (no flag needed). iOS is untouched: ios-local-agent-kernel
 * loads the package via a dynamic import, so the npm dependency stays.
 *
 * Opt back into the full second library (not the stub) with
 * ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR=1. Idempotent.
 */
export function dropRetiredLlamaCppFromAndroidGradle() {
  if (
    process.env.ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR === "1" ||
    process.env.elizaIncludeLlamaCppCapacitor === "true"
  ) {
    return;
  }
  const targets = [
    path.join(androidDir, "capacitor.settings.gradle"),
    path.join(androidDir, "app", "capacitor.build.gradle"),
  ];
  let dropped = false;
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    const before = fs.readFileSync(target, "utf8");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("llama-cpp-capacitor"))
      .join("\n");
    if (after !== before) {
      fs.writeFileSync(target, after, "utf8");
      dropped = true;
    }
  }
  if (dropped) {
    console.log(
      "[mobile-build] Dropped retired llama-cpp-capacitor from the Android gradle build (no stub CMake; libelizainference is the sole in-process inference lib).",
    );
  }
}

/**
 * Drop capacitor.plugins.json entries whose gradle module is not included in
 * androidDir/capacitor.settings.gradle. Uses Capacitor's canonical package →
 * gradle-project derivation (`pkg.replace(/@/g,"").replace(/\//g,"-")`), so
 * `@capacitor/preferences`→`capacitor-preferences`,
 * `@elizaos/capacitor-agent`→`elizaos-capacitor-agent`,
 * `llama-cpp-capacitor`→`llama-cpp-capacitor`. Keeping the manifest in lockstep
 * with the compiled module set is what stops PluginManager.loadPluginClasses
 * from throwing on a class that isn't on the dex.
 */
export function reconcilePluginManifestWithGradle(targetAssets) {
  const manifestPath = path.join(targetAssets, "capacitor.plugins.json");
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(settingsPath)) return;

  const settings = fs.readFileSync(settingsPath, "utf8");
  const compiledProjects = new Set(
    [...settings.matchAll(/include ':([^']+)'/g)].map((m) => m[1]),
  );

  let plugins;
  try {
    plugins = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[mobile-build] Could not parse capacitor.plugins.json for gradle reconciliation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(plugins)) return;

  const gradleProjectFor = (pkg) =>
    String(pkg ?? "")
      .replace(/@/g, "")
      .replace(/\//g, "-");
  // The llama-cpp-capacitor plugin is RETIRED on Android: agent inference runs
  // entirely through the single fused libelizainference.so, and nothing loads
  // this plugin's separate libllama-cpp-arm64.so (its JS adapter is retired).
  // dropRetiredLlamaCppFromAndroidGradle() (called above) removes its gradle
  // project outright, so its CMake never runs — there is no stub to register
  // and no ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB opt-out to set. We also drop it from
  // the plugins manifest here so the LlamaCpp class never auto-registers. The
  // device-bridge's optional LlamaCpp import resolves to a catchable "plugin not
  // implemented" JS error, which costs nothing. Opt the full second library back
  // in (gradle project + manifest) only with ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR=1.
  const stubLlamaCpp =
    process.env.ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR !== "1" &&
    process.env.elizaIncludeLlamaCppCapacitor !== "true";
  // Third-party Capacitor plugins that `cap sync` includes (they ship an
  // android/ dir, so they ARE in capacitor.settings.gradle) but whose Kotlin
  // plugin class never lands in the app dex on AGP 8.x: both rely on AGP's
  // built-in Kotlin instead of applying `org.jetbrains.kotlin.android`, so the
  // built-in kotlinc compiles the .kt but does NOT bundle the .class into the
  // library AAR. PluginManager.loadPluginClasses then throws "Could not find
  // class …" on the first one and aborts the ENTIRE plugin load, so EVERY
  // plugin (Browser, Haptics, Keyboard, …) silently fails to register. We can't
  // edit node_modules durably, and neither is needed for the core Android app —
  // background work uses WorkManager (ElizaWorkScheduler) and barcode scanning
  // is a companion-pairing-only feature — so drop them from the manifest. (Our
  // own native plugins fix this properly by applying the Kotlin plugin in their
  // android/build.gradle.)
  const nonBundlingThirdPartyPlugins = new Set([
    "@capacitor/background-runner",
    "@capacitor/barcode-scanner",
  ]);
  const isCompiledAndUsable = (plugin) => {
    if (!compiledProjects.has(gradleProjectFor(plugin?.pkg))) return false;
    if (stubLlamaCpp && plugin?.pkg === "llama-cpp-capacitor") return false;
    if (nonBundlingThirdPartyPlugins.has(plugin?.pkg)) return false;
    return true;
  };
  const kept = plugins.filter(isCompiledAndUsable);

  // `cap sync` wires `@capacitor/local-notifications` into the gradle project
  // (capacitor.settings.gradle / capacitor.build.gradle) but does NOT emit its
  // auto-register entry into capacitor.plugins.json — so the compiled
  // LocalNotificationsPlugin class never auto-registers and the JS bridge
  // (`Capacitor.Plugins.LocalNotifications`) resolves to undefined on-device.
  // Add it back when its module is compiled. (Verified on Pixel 9a: without
  // this entry LocalNotifications.schedule is unavailable; with it, native
  // notifications fire.)
  const LOCAL_NOTIFICATIONS_PKG = "@capacitor/local-notifications";
  if (
    compiledProjects.has("capacitor-local-notifications") &&
    !kept.some((plugin) => plugin?.pkg === LOCAL_NOTIFICATIONS_PKG)
  ) {
    kept.push({
      pkg: LOCAL_NOTIFICATIONS_PKG,
      classpath:
        "com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin",
    });
  }

  const before = JSON.stringify(plugins);
  const after = JSON.stringify(kept);
  if (before !== after) {
    const dropped = plugins
      .filter((plugin) => !isCompiledAndUsable(plugin))
      .map((plugin) => plugin?.pkg)
      .join(", ");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(kept, null, "\t")}\n`,
      "utf8",
    );
    console.log(
      `[mobile-build] Reconciled capacitor.plugins.json with capacitor.settings.gradle (${dropped ? `dropped: ${dropped}; ` : ""}ensured LocalNotifications).`,
    );
  }
}
