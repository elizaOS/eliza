/** Exercises run mobile build plugin manifest behavior with deterministic app-core test fixtures. */
import { expect, it } from "vitest";

import {
  ANDROID_OFFICIAL_CAPACITOR_PACKAGES,
  IOS_COCOAPODS_OWNED_SPM_PLUGINS,
  IOS_OFFICIAL_PODS,
  MOBILE_CAPACITOR_PLUGIN_MANIFEST,
  resolveIosCustomPods,
} from "./run-mobile-build.mjs";

function manifestIosPods() {
  return MOBILE_CAPACITOR_PLUGIN_MANIFEST.flatMap((plugin) =>
    (plugin.iosPods ?? []).map((pod) => [pod, plugin.packageName]),
  );
}

it("derives the Android and iOS official package tables from the mobile plugin manifest", () => {
  expect(ANDROID_OFFICIAL_CAPACITOR_PACKAGES).toEqual(
    MOBILE_CAPACITOR_PLUGIN_MANIFEST.filter(
      (plugin) => plugin.android?.patchAgp9,
    ).map((plugin) => plugin.packageName),
  );

  expect(IOS_OFFICIAL_PODS).toEqual(
    manifestIosPods()
      .filter(([pod]) => pod.kind === "official")
      .map(([pod, packageName]) => [pod.name, packageName]),
  );

  expect(ANDROID_OFFICIAL_CAPACITOR_PACKAGES).toContain(
    "@capacitor-community/background-runner",
  );
  expect(ANDROID_OFFICIAL_CAPACITOR_PACKAGES).not.toContain(
    "@capacitor/network",
  );
});

it("keeps the existing iOS custom pod include gates", () => {
  const defaultPods = new Map(resolveIosCustomPods());
  expect(defaultPods.get("ElizaosCapacitorAgent")).toBe(
    "@elizaos/capacitor-agent",
  );
  expect(defaultPods.has("ElizaosCapacitorBunRuntime")).toBe(false);
  expect(defaultPods.has("ElizaosCapacitorMobileAgentBridge")).toBe(false);
  expect(defaultPods.has("LlamaCpp")).toBe(false);
  expect(defaultPods.has("ElizaBunEngine")).toBe(false);

  const appStorePods = new Map(
    resolveIosCustomPods({
      appStoreBuild: true,
      includeFullBunEngine: true,
      includeLlama: true,
      includeMobileAgentBridge: true,
    }),
  );
  expect(appStorePods.get("ElizaosCapacitorBunRuntime")).toBe(
    "@elizaos/capacitor-bun-runtime",
  );
  expect(appStorePods.get("ElizaBunEngine")).toBe("@elizaos/bun-ios-runtime");
  expect(appStorePods.has("ElizaosCapacitorMobileAgentBridge")).toBe(false);
  expect(appStorePods.has("LlamaCpp")).toBe(false);

  const localPods = new Map(
    resolveIosCustomPods({
      appStoreBuild: false,
      includeFullBunEngine: true,
      includeLlama: true,
    }),
  );
  expect(localPods.get("ElizaosCapacitorMobileAgentBridge")).toBe(
    "@elizaos/capacitor-mobile-agent-bridge",
  );
  expect(localPods.get("LlamaCpp")).toBe("llama-cpp-capacitor");
  expect(localPods.get("LlamaCppCapacitor")).toBe("llama-cpp-capacitor");
});

it("derives the iOS CocoaPods-owned SPM strip set from manifest annotations", () => {
  const ownedSpmPlugins = new Set(
    manifestIosPods()
      .filter(([pod]) => pod.spmHandling === "cocoapods-owned")
      .map(([pod]) => pod.name),
  );

  expect(IOS_COCOAPODS_OWNED_SPM_PLUGINS).toEqual(ownedSpmPlugins);
  expect([...IOS_COCOAPODS_OWNED_SPM_PLUGINS].sort()).toEqual([
    "LlamaCpp",
    "LlamaCppCapacitor",
  ]);
});
