/**
 * useDefaultProviderPresets — React wrapper around `pickDefaultVoiceProvider`.
 *
 * Combines the authoritative runtime-mode snapshot from `useRuntimeMode`
 * with the build-time platform detector from `../platform` to produce
 * the device+mode-aware default {tts, asr} pair. Consumed by
 * `ProviderSwitcher` and `VoiceConfigView` when the user hasn't picked
 * a provider explicitly.
 *
 * The hook is read-only — it never writes to user config. Callers are
 * responsible for applying the suggested defaults on first paint when
 * the persisted `VoiceConfig.provider` / `VoiceConfig.asr.provider`
 * is undefined.
 */
import {
  type DefaultVoiceProviderResult,
  type PresetPlatform,
  type PresetRuntimeMode,
} from "../voice/voice-provider-defaults";
export interface UseDefaultProviderPresetsOptions {
  /**
   * Test-only override for the platform detection. Production code
   * should leave this undefined and trust `isDesktopPlatform()` /
   * `isWebPlatform()` from the platform module.
   */
  platformOverride?: PresetPlatform;
  /**
   * Test-only override for the runtime mode. Production code should
   * leave this undefined and let `useRuntimeMode` resolve from
   * `/api/runtime/mode`.
   */
  runtimeModeOverride?: PresetRuntimeMode;
}
export interface UseDefaultProviderPresetsResult {
  /** The resolved default pair. */
  defaults: DefaultVoiceProviderResult;
  /** Resolved platform that produced the defaults. */
  platform: PresetPlatform;
  /** Resolved runtime mode that produced the defaults. */
  runtimeMode: PresetRuntimeMode;
  /**
   * True while we're still waiting for the runtime-mode snapshot. The
   * defaults are still safe to use during loading (they fall back to
   * the cloud-everything pick), but consumers may want to defer
   * "did the user override?" logic until the snapshot is ready.
   */
  loading: boolean;
}
export declare function useDefaultProviderPresets(
  options?: UseDefaultProviderPresetsOptions,
): UseDefaultProviderPresetsResult;
//# sourceMappingURL=useDefaultProviderPresets.d.ts.map
