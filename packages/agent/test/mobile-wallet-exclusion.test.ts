/**
 * Android residents (the stock APK and the elizaOS AOSP image runtime) never load the wallet
 * plugin, so no transfer, swap or signing action exists there even when config, an allow list or
 * wallet keys in the environment ask for it. Products that ship this profile (for example a phone
 * whose MVP excludes Wallet) rely on that; enabling Wallet on Android is a deliberate profile change
 * that must update this test.
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  ELIZAOS_ANDROID_CORE_PLUGINS,
  ELIZAOS_ANDROID_TERMINAL_PLUGINS,
  MOBILE_CORE_PLUGINS,
  MOBILE_MODEL_PROVIDER_PLUGINS,
  MOBILE_VIEW_PLUGINS,
} from "../src/runtime/core-plugins.ts";
import { collectPluginNames } from "../src/runtime/plugin-collector.ts";

const WALLET = "@elizaos/plugin-wallet";

afterEach(() => vi.unstubAllEnvs());

it("keeps the wallet out of every list an Android resident may load", () => {
  for (const list of [
    MOBILE_CORE_PLUGINS,
    MOBILE_VIEW_PLUGINS,
    MOBILE_MODEL_PROVIDER_PLUGINS,
    ELIZAOS_ANDROID_CORE_PLUGINS,
    ELIZAOS_ANDROID_TERMINAL_PLUGINS,
  ]) {
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toContain(WALLET);
    expect(list.some((name) => /wallet/i.test(name))).toBe(false);
  }
});

it.each([
  ["stock APK", "0"],
  ["AOSP image", "1"],
])(
  "does not load the wallet on an Android %s resident even when requested",
  (_profile, localLlama) => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    vi.stubEnv("ELIZA_LOCAL_LLAMA", localLlama);
    vi.stubEnv("SOLANA_PRIVATE_KEY", "fixture-solana-key");
    vi.stubEnv("EVM_PRIVATE_KEY", "0xfixture");
    vi.stubEnv("WALLET_PUBLIC_KEY", "fixture-public-key");
    const selected = collectPluginNames({
      plugins: {
        allow: [WALLET, "wallet"],
        entries: { wallet: { enabled: true } },
      },
    });
    expect(selected.has(WALLET)).toBe(false);
    expect([...selected].some((name) => /wallet/i.test(name))).toBe(false);
  },
);

it("honors the same request on a desktop host, so the Android result is the profile's", () => {
  vi.stubEnv("ELIZA_PLATFORM", "linux");
  vi.stubEnv("ELIZA_PLUGIN_SET", "");
  expect(collectPluginNames({ plugins: { allow: [WALLET] } }).has(WALLET)).toBe(
    true,
  );
});
