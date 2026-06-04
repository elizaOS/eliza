/**
 * VoiceSectionMount — settings-registry-compatible wrapper around VoiceSection.
 *
 * The settings registry mounts each section's `Component` with no props, but
 * VoiceSection needs `prefs`, `onPrefsChange`, and a `profilesClient`. This
 * wrapper supplies them from the real runtime:
 *
 * - profilesClient: a real `VoiceProfilesClient` over the shared `ElizaClient`,
 *   the same construction onboarding uses (`VoicePrefixGate`).
 * - prefs: loaded from and persisted to the agent config store under
 *   `messages.voice` — the same `getConfig()` / `updateConfig()` path the other
 *   settings sections use (see `IdentitySettingsSection` for `messages.tts`).
 */

import * as React from "react";
import { client } from "../../api/client";
import { createVoiceProfilesClient } from "../../api/client-voice-profiles";
import { saveVadAutoStop } from "../../state/persistence";
import {
  VOICE_CONTINUOUS_MODES,
  type VoiceContinuousMode,
} from "../../voice/voice-chat-types";
import {
  DEFAULT_VAD_AUTO_STOP_PREFS,
  DEFAULT_VOICE_SECTION_PREFS,
  type VadAutoStopPrefs,
  type VoiceLocalCloudStrategy,
  VoiceSection,
  type VoiceSectionPrefs,
} from "./VoiceSection";

const VOICE_PREFS_CONFIG_KEY = "voice";

const profilesClient = createVoiceProfilesClient(client);

function isContinuousMode(value: unknown): value is VoiceContinuousMode {
  return (
    typeof value === "string" &&
    VOICE_CONTINUOUS_MODES.includes(value as VoiceContinuousMode)
  );
}

function isLocalCloudStrategy(
  value: unknown,
): value is VoiceLocalCloudStrategy {
  return value === "auto" || value === "force-local" || value === "force-cloud";
}

function readVadAutoStop(value: unknown): VadAutoStopPrefs {
  const stored = (value ?? {}) as Record<string, unknown>;
  return {
    silenceMs:
      typeof stored.silenceMs === "number" && Number.isFinite(stored.silenceMs)
        ? stored.silenceMs
        : DEFAULT_VAD_AUTO_STOP_PREFS.silenceMs,
    speechRmsThreshold:
      typeof stored.speechRmsThreshold === "number" &&
      Number.isFinite(stored.speechRmsThreshold)
        ? stored.speechRmsThreshold
        : DEFAULT_VAD_AUTO_STOP_PREFS.speechRmsThreshold,
  };
}

function readStoredVoicePrefs(
  config: Record<string, unknown>,
): VoiceSectionPrefs {
  const messages = (config.messages ?? {}) as Record<string, unknown>;
  const stored = (messages[VOICE_PREFS_CONFIG_KEY] ?? {}) as Record<
    string,
    unknown
  >;
  return {
    continuous: isContinuousMode(stored.continuous)
      ? stored.continuous
      : DEFAULT_VOICE_SECTION_PREFS.continuous,
    strategy: isLocalCloudStrategy(stored.strategy)
      ? stored.strategy
      : DEFAULT_VOICE_SECTION_PREFS.strategy,
    cloudFirstLineCache:
      typeof stored.cloudFirstLineCache === "boolean"
        ? stored.cloudFirstLineCache
        : DEFAULT_VOICE_SECTION_PREFS.cloudFirstLineCache,
    autoLearnVoices:
      typeof stored.autoLearnVoices === "boolean"
        ? stored.autoLearnVoices
        : DEFAULT_VOICE_SECTION_PREFS.autoLearnVoices,
    vadAutoStop: readVadAutoStop(stored.vadAutoStop),
  };
}

export function VoiceSectionMount(): React.ReactElement {
  const [prefs, setPrefs] = React.useState<VoiceSectionPrefs>(
    DEFAULT_VOICE_SECTION_PREFS,
  );
  const [persistError, setPersistError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await client.getConfig();
      if (cancelled) return;
      const loaded = readStoredVoicePrefs(config);
      setPrefs(loaded);
      // Seed the local mirror so the capture hot path reads the server value.
      if (loaded.vadAutoStop) saveVadAutoStop(loaded.vadAutoStop);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePrefsChange = React.useCallback(
    async (next: VoiceSectionPrefs) => {
      setPrefs(next);
      setPersistError(null);
      // Mirror to localStorage immediately so the capture path picks up the new
      // VAD thresholds without waiting on the config round-trip.
      if (next.vadAutoStop) saveVadAutoStop(next.vadAutoStop);
      try {
        const config = await client.getConfig();
        const messages = (config.messages ?? {}) as Record<string, unknown>;
        await client.updateConfig({
          messages: { ...messages, [VOICE_PREFS_CONFIG_KEY]: next },
        });
      } catch (error) {
        setPersistError(
          error instanceof Error
            ? error.message
            : "Failed to save voice settings.",
        );
      }
    },
    [],
  );

  return (
    <>
      {persistError ? (
        <p
          className="px-4 pt-4 text-xs text-warn"
          role="alert"
          data-testid="voice-section-persist-error"
        >
          {persistError}
        </p>
      ) : null}
      <VoiceSection
        tier={null}
        prefs={prefs}
        onPrefsChange={(next) => void handlePrefsChange(next)}
        profilesClient={profilesClient}
      />
    </>
  );
}

export default VoiceSectionMount;
