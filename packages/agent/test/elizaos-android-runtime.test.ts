/**
 * bin.ts evaluates plugin-native-inference only when isElizaOsAndroidRuntime()
 * holds, and registers lazy loaders for the Android app plugins on every
 * Android boot. Config can set ELIZA_LOCAL_LLAMA after bin.ts runs, so the
 * collector may ask for the app plugins later; their loaders must be there.
 */
import { readFileSync } from "node:fs";
import { isElizaOsAndroidRuntime } from "@elizaos/host/protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  ANDROID_APP_PLUGIN_NAMES,
  registerAndroidAppPluginLoaders,
} from "../src/runtime/android-app-plugin-loaders.ts";
import { ELIZAOS_ANDROID_CORE_PLUGINS } from "../src/runtime/core-plugins.ts";
import { collectPluginNames } from "../src/runtime/plugin-collector.ts";
import { STATIC_ELIZA_PLUGIN_LOADERS } from "../src/runtime/plugin-types.ts";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["android", "1", true],
  ["android", " 1 ", true],
  ["android", "0", false],
  ["android", "", false],
  ["ios", "1", false],
  ["linux", "1", false],
])(
  "platform %s with ELIZA_LOCAL_LLAMA=%j: ElizaOS Android is %s",
  (platform, localLlama, expected) => {
    vi.stubEnv("ELIZA_PLATFORM", platform);
    vi.stubEnv("ELIZA_LOCAL_LLAMA", localLlama);
    expect(isElizaOsAndroidRuntime()).toBe(expected);
    const selected = collectPluginNames({});
    for (const name of ELIZAOS_ANDROID_CORE_PLUGINS)
      expect(selected.has(name), name).toBe(expected);
  },
);

it("bin.ts registers app loaders on Android and gates the AOSP block", () => {
  const bin = readFileSync(new URL("../src/bin.ts", import.meta.url), "utf8");
  const body = bin.slice(
    bin.indexOf("async function bootstrapMobileEntrypoint"),
    bin.indexOf('const { runAutonomousCli } = await import("./cli/index.ts")'),
  );
  const androidGate = body.indexOf("if (isAndroidMobile()) {");
  const loaders = body.indexOf("registerAndroidAppPluginLoaders();");
  const aospGate = body.indexOf("if (isElizaOsAndroidRuntime()) {");
  const inference = body.indexOf('"@elizaos/plugin-native-inference"');
  const appPlugins = body.indexOf('import("./runtime/android-app-plugins.ts")');
  expect(androidGate).toBeGreaterThanOrEqual(0);
  expect(loaders).toBeGreaterThan(androidGate);
  expect(aospGate).toBeGreaterThan(loaders);
  expect(inference).toBeGreaterThan(aospGate);
  expect(appPlugins).toBeGreaterThan(aospGate);
});

it("config enabling local llama after boot still finds the app plugins", async () => {
  // bin.ts ran on plain Android: no ELIZA_LOCAL_LLAMA yet.
  vi.stubEnv("ELIZA_PLATFORM", "android");
  vi.stubEnv("ELIZA_LOCAL_LLAMA", "");
  registerAndroidAppPluginLoaders();
  // Config sets it later; the collector now asks for the app plugins.
  vi.stubEnv("ELIZA_LOCAL_LLAMA", "1");
  const selected = collectPluginNames({});
  for (const name of ANDROID_APP_PLUGIN_NAMES) {
    expect(selected.has(name), name).toBe(true);
    expect(typeof STATIC_ELIZA_PLUGIN_LOADERS[name], name).toBe("function");
  }
  const wifi = (await STATIC_ELIZA_PLUGIN_LOADERS[
    "@elizaos/plugin-native-wifi"
  ]()) as { default?: { name?: unknown } };
  expect(typeof wifi.default?.name).toBe("string");
});
