/**
 * bin.ts evaluates the AOSP-only app plugins only when isElizaOsAndroidRuntime()
 * holds. The collector must request those plugins under exactly the same rule,
 * or a requested plugin would be missing from the static registry.
 */
import { isElizaOsAndroidRuntime } from "@elizaos/host/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { ELIZAOS_ANDROID_CORE_PLUGINS } from "../src/runtime/core-plugins.ts";
import { collectPluginNames } from "../src/runtime/plugin-collector.ts";

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
