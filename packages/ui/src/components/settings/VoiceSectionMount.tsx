/**
 * VoiceSectionMount — settings-registry-compatible wrapper around VoiceSection.
 *
 * The settings registry mounts each section's `Component` with no props.
 * VoiceSection itself needs `tier`, `prefs`, `onPrefsChange`, and a
 * `profilesClient`. This wrapper supplies safe defaults so the section
 * renders in the dashboard before the rest of the I-wave catches up:
 *
 * - tier: defaults to `null` → VoiceSection falls back to GOOD copy.
 * - prefs: local component state seeded with DEFAULT_VOICE_SECTION_PREFS.
 *   When I5 lands the voice-prefs cloud sync, swap this for the real
 *   settings store.
 * - profilesClient: built from a minimal `fetch` stub. The
 *   VoiceProfilesClient adapter returns an empty list when the server
 *   isn't running yet.
 *
 * Once I5 lands the settings-sync side we replace this wrapper with a
 * direct mount that reads from the real settings store.
 */

// biome-ignore lint/correctness/noUnusedImports: required for JSX transform.
import * as React from "react";
import { VoiceProfilesClient } from "../../api/client-voice-profiles";
import {
  DEFAULT_VOICE_SECTION_PREFS,
  VoiceSection,
  type VoiceSectionPrefs,
} from "./VoiceSection";

function buildFallbackProfilesClient(): VoiceProfilesClient {
  return new VoiceProfilesClient({
    fetch: async <T,>(path: string): Promise<T> => {
      throw Object.assign(new Error(`Voice endpoint not registered: ${path}`), {
        status: 404,
      });
    },
  });
}

export function VoiceSectionMount(): React.ReactElement {
  const [prefs, setPrefs] = React.useState<VoiceSectionPrefs>(
    DEFAULT_VOICE_SECTION_PREFS,
  );
  const profilesClient = React.useMemo(buildFallbackProfilesClient, []);

  return (
    <VoiceSection
      tier={null}
      prefs={prefs}
      onPrefsChange={setPrefs}
      profilesClient={profilesClient}
    />
  );
}

export default VoiceSectionMount;
