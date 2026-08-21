/**
 * Pins ownership of every platform-deferred surface emitted by the canonical
 * runtime inventory so additions, removals, or silent reclassification fail.
 */
export const NATIVE_PLATFORM_INVENTORY_SOURCE =
  "elizaOS/eliza@256cdd67bbd2459291e55100046fb909daa47f6d:packages/scripts/e2e-coverage/runtime-surface-baseline.json" as const;

export const NATIVE_PLATFORM_SURFACE_IDS = [
  "@elizaos/app-core:native-bridge:capacitorjsc",
  "@elizaos/app-core:native-bridge:capacitorquickjs",
  "@elizaos/app-core:native-bridge:elizabunruntime",
  "@elizaos/capacitor-agent:native-bridge:agent",
  "@elizaos/capacitor-appblocker:native-bridge:elizaappblocker",
  "@elizaos/capacitor-browser-surface:native-bridge:elizasurfacemanager",
  "@elizaos/capacitor-bun-runtime:native-bridge:elizabunruntime",
  "@elizaos/capacitor-calendar:native-bridge:applecalendar",
  "@elizaos/capacitor-camera:native-bridge:elizacamera",
  "@elizaos/capacitor-canvas:native-bridge:elizacanvas",
  "@elizaos/capacitor-contacts:native-bridge:elizacontacts",
  "@elizaos/capacitor-desktop:native-bridge:desktop",
  "@elizaos/capacitor-eliza-tasks:native-bridge:elizatasks",
  "@elizaos/capacitor-gateway:native-bridge:gateway",
  "@elizaos/capacitor-llama:service:localinferenceloader",
  "@elizaos/capacitor-location:native-bridge:elizalocation",
  "@elizaos/capacitor-messages:native-bridge:elizamessages",
  "@elizaos/capacitor-mlkit-text:native-bridge:tesseract",
  "@elizaos/capacitor-mobile-agent-bridge:native-bridge:mobileagentbridge",
  "@elizaos/capacitor-mobile-signals:native-bridge:mobilesignals",
  "@elizaos/capacitor-network-policy:native-bridge:elizanetworkpolicy",
  "@elizaos/capacitor-phone:native-bridge:elizaphone",
  "@elizaos/capacitor-screencapture:native-bridge:screencapture",
  "@elizaos/capacitor-swabble:native-bridge:swabble",
  "@elizaos/capacitor-system:native-bridge:elizasystem",
  "@elizaos/capacitor-talkmode:native-bridge:talkmode",
  "@elizaos/capacitor-websiteblocker:native-bridge:elizawebsiteblocker",
  "@elizaos/capacitor-wifi:native-bridge:elizawifi",
  "@elizaos/macosalarm:action:alarm",
  "@elizaos/plugin-native-filesystem:service:devicefilesystembridge",
  "@elizaos/plugin-native-inference:model-handler:text_embedding",
  "@elizaos/plugin-native-inference:model-handler:text_large",
  "@elizaos/plugin-native-inference:model-handler:text_small",
  "@elizaos/plugin-native-inference:model-handler:text_to_speech",
  "@elizaos/plugin-native-inference:model-handler:transcription",
  "@elizaos/plugin-native-settings:view:elizaos/plugin-native-settings",
  "@elizaos/plugin-phone:native-bridge:elizaintent",
] as const;

export function assertNativePlatformOwnership(
  platformDeferredSurfaceIds: readonly string[],
): void {
  const expected = [...NATIVE_PLATFORM_SURFACE_IDS].sort();
  const expectedSet = new Set<string>(expected);
  const actual = [...new Set(platformDeferredSurfaceIds)].sort();
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expectedSet.has(id));
  if (actual.length !== platformDeferredSurfaceIds.length) {
    throw new Error("Native platform inventory contains duplicate surface ids");
  }
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Native platform ownership drifted (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
}
