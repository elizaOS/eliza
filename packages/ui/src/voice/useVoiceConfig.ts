import * as React from "react";

import { client } from "../api/client";
import type { VoiceConfig } from "../api/client-types-config";
import { VOICE_CONFIG_UPDATED_EVENT } from "../events";
import { useDefaultProviderPresets } from "../hooks/useDefaultProviderPresets";
import {
  applyVoiceProviderDefaults,
  resolveCharacterVoiceConfigFromAppConfig,
} from "./character-voice-config";

export interface UseVoiceConfigResult {
  /** Saved voice config with platform/runtime provider defaults applied. Never null. */
  voiceConfig: VoiceConfig;
  /** Bumps after each settled load (`0` until the first load resolves). Gate auto-speak on `> 0`. */
  voiceBootstrapTick: number;
  /** Re-fetch the saved voice config (e.g. after cloud status changes). */
  reloadVoiceConfig: () => void;
}

/**
 * Loads the saved character/TTS voice config from the server, applies platform +
 * runtime provider defaults, and keeps it fresh across
 * {@link VOICE_CONFIG_UPDATED_EVENT}. Shared by the full ChatView voice
 * controller and the ambient `/chat` overlay so both resolve the *same* TTS
 * provider/voice — there is a single voice-config pipeline, not two.
 */
export function useVoiceConfig(uiLanguage: string): UseVoiceConfigResult {
  const { defaults: voiceProviderDefaults } = useDefaultProviderPresets();
  const [voiceConfig, setVoiceConfig] = React.useState<VoiceConfig | null>(
    null,
  );
  const [voiceBootstrapTick, setVoiceBootstrapTick] = React.useState(0);
  const isMountedRef = React.useRef(false);

  const loadVoiceConfig = React.useCallback(async () => {
    try {
      const cfg = await client.getConfig();
      const resolved = resolveCharacterVoiceConfigFromAppConfig({
        config: cfg,
        uiLanguage,
      });
      if (!isMountedRef.current) return;
      setVoiceConfig(resolved.voiceConfig);
      if (resolved.shouldPersist && resolved.voiceConfig) {
        void client
          .updateConfig({ messages: { tts: resolved.voiceConfig } })
          .catch(() => {});
      }
    } catch {
      if (!isMountedRef.current) return;
      // No config endpoint / parse failure — fall back to provider defaults.
      setVoiceConfig(null);
    } finally {
      if (isMountedRef.current) {
        setVoiceBootstrapTick((tick) => tick + 1);
      }
    }
  }, [uiLanguage]);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    void loadVoiceConfig();
  }, [loadVoiceConfig]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<VoiceConfig | undefined>).detail;
      if (detail && typeof detail === "object") {
        setVoiceConfig(detail);
        setVoiceBootstrapTick((tick) => tick + 1);
        return;
      }
      void loadVoiceConfig();
    };
    window.addEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
    return () =>
      window.removeEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
  }, [loadVoiceConfig]);

  const voiceConfigWithDefaults = React.useMemo(
    () => applyVoiceProviderDefaults(voiceConfig, voiceProviderDefaults),
    [voiceConfig, voiceProviderDefaults],
  );

  const reloadVoiceConfig = React.useCallback(() => {
    void loadVoiceConfig();
  }, [loadVoiceConfig]);

  return {
    voiceConfig: voiceConfigWithDefaults,
    voiceBootstrapTick,
    reloadVoiceConfig,
  };
}
