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
import type { DeviceTier } from "../../api/client-local-inference";
import { createVoiceProfilesClient } from "../../api/client-voice-profiles";
import {
  loadWakeWordEnabled,
  saveContinuousChatMode,
  saveVadAutoStop,
  saveWakeWordEnabled,
} from "../../state/persistence";
import {
  VOICE_CONTINUOUS_MODES,
  type VoiceContinuousMode,
} from "../../voice/voice-chat-types";
import {
  type VadAutoStopPrefs,
  VoiceSection,
  type VoiceSectionPrefs,
} from "./VoiceSection";
import {
  DEFAULT_VAD_AUTO_STOP_PREFS,
  DEFAULT_VOICE_SECTION_PREFS,
} from "./VoiceSection.helpers";

const VOICE_PREFS_CONFIG_KEY = "voice";

const profilesClient = createVoiceProfilesClient(client);

function isContinuousMode(value: unknown): value is VoiceContinuousMode {
  return (
    typeof value === "string" &&
    VOICE_CONTINUOUS_MODES.includes(value as VoiceContinuousMode)
  );
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
  // Note: legacy `cloudFirstLineCache` / `autoLearnVoices` keys may still sit
  // in older persisted `messages.voice` blobs; they are dead (no readers) and
  // intentionally dropped here — see the removal note in VoiceSection.tsx.
  return {
    continuous: isContinuousMode(stored.continuous)
      ? stored.continuous
      : DEFAULT_VOICE_SECTION_PREFS.continuous,
    vadAutoStop: readVadAutoStop(stored.vadAutoStop),
  };
}

export function VoiceSectionMount(): React.ReactElement {
  const [prefs, setPrefs] = React.useState<VoiceSectionPrefs>(
    DEFAULT_VOICE_SECTION_PREFS,
  );
  const [persistError, setPersistError] = React.useState<string | null>(null);
  // Wake-word listening is a device-local pref (localStorage mirror the shell
  // reads synchronously — see useShellController's useWakeListenWindow), not part
  // of the `messages.voice` config blob. Seed from the persisted value.
  const [wakeWordEnabled, setWakeWordEnabled] = React.useState<boolean>(() =>
    loadWakeWordEnabled(),
  );
  const [tier, setTier] = React.useState<DeviceTier | null>(null);
  const [tierSummary, setTierSummary] = React.useState<string | undefined>(
    undefined,
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let config: Record<string, unknown> = {};
      try {
        config = await client.getConfig();
      } catch {
        // Config fetch failed (offline / server error) — fall back to the
        // defaults readStoredVoicePrefs derives from an empty config so the
        // localStorage mirrors below are still seeded (an unhandled rejection
        // here would leave the capture hot path with no value at all).
      }
      if (cancelled) return;
      const loaded = readStoredVoicePrefs(config);
      setPrefs(loaded);
      // Seed the local mirrors so the capture hot path reads the server value.
      if (loaded.vadAutoStop) saveVadAutoStop(loaded.vadAutoStop);
      // The surfaces that implement continuous chat (ChatView,
      // useShellController) read ONLY the localStorage mirror via
      // loadContinuousChatMode — never `messages.voice.continuous` — so the
      // server value must be seeded into it, same as vadAutoStop above.
      saveContinuousChatMode(loaded.continuous);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.getLocalInferenceDeviceTier();
        if (cancelled) return;
        setTier(result.tier);
        setTierSummary(result.reason);
      } catch {
        // Tier probe failed — keep the null-tier default (VoiceSection renders
        // without the tier banner) instead of surfacing an unhandled rejection.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the wake-word toggle and update local state so the control reflects
  // it immediately; the shell picks the new value up on its next render.
  const handleWakeWordToggle = React.useCallback((next: boolean) => {
    setWakeWordEnabled(next);
    saveWakeWordEnabled(next);
  }, []);

  const handlePrefsChange = React.useCallback(
    async (next: VoiceSectionPrefs) => {
      setPrefs(next);
      setPersistError(null);
      // Mirror to localStorage immediately so the capture path picks up the new
      // VAD thresholds without waiting on the config round-trip.
      if (next.vadAutoStop) saveVadAutoStop(next.vadAutoStop);
      // Mirror continuous-chat mode too: ChatView / useShellController read it
      // synchronously from localStorage (loadContinuousChatMode) and never see
      // the `messages.voice.continuous` config blob.
      saveContinuousChatMode(next.continuous);
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
        tier={tier}
        tierSummary={tierSummary}
        prefs={prefs}
        onPrefsChange={(next) => void handlePrefsChange(next)}
        profilesClient={profilesClient}
        wakeWordEnabled={wakeWordEnabled}
        onWakeWordToggle={handleWakeWordToggle}
      />
    </>
  );
}

export default VoiceSectionMount;
