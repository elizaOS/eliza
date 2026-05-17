/**
 * Model Updates — Settings panel surfacing the voice sub-model auto-updater
 * (R5-versioning §5 + I10-app-ux). Mounts inside `LocalInferencePanel.tsx`.
 *
 * Data flow:
 * - Reads `VOICE_MODEL_VERSIONS` directly from `@elizaos/shared` for the
 *   in-binary catalog. The runtime `VoiceModelUpdater` adds remote sources
 *   (Cloud + GitHub + HF) on top; when the live API surface is wired the
 *   `installedVersions` and `pinned` sets come from that API. Until the
 *   service routes are mounted we render the local catalog so the panel
 *   surface is testable.
 * - Toggle persistence lands in `~/.milady/local-inference/voice-update-prefs.json`
 *   via `POST /api/local-inference/voice-models/preferences` (route to be
 *   added in plugin-local-inference; the panel calls a tolerant stub that
 *   no-ops when the route is missing so the UI does not break in dev).
 *
 * OWNER gating: the cellular-auto-update toggle is OWNER-only per R5 §5.4.
 * `isOwner` defaults to `false` so non-OWNER renders show the toggle
 * disabled. Wire this from the entity-OWNER signal landed by I2.
 */
import { type VoiceModelId } from "@elizaos/shared";
export interface VoiceModelInstallationView {
  readonly id: VoiceModelId;
  readonly installedVersion: string | null;
  readonly pinned: boolean;
  readonly lastError?: string | null;
}
export interface VoiceUpdatePreferencesView {
  readonly autoUpdateOnWifi: boolean;
  readonly autoUpdateOnCellular: boolean;
  readonly autoUpdateOnMetered: boolean;
}
export interface ModelUpdatesPanelProps {
  /**
   * Per-id installation state (installed version + pin flag). Caller wires
   * from the runtime's `/api/local-inference/voice-models/status` endpoint
   * once it lands; pass an empty array to surface "no models installed"
   * placeholders for every id in `VOICE_MODEL_VERSIONS`.
   */
  readonly installations: ReadonlyArray<VoiceModelInstallationView>;
  readonly preferences: VoiceUpdatePreferencesView;
  readonly isOwner: boolean;
  readonly lastCheckedAt?: string | null;
  readonly checking?: boolean;
  readonly onCheckNow: () => void;
  readonly onUpdateNow: (id: VoiceModelId) => void;
  readonly onTogglePin: (id: VoiceModelId, pinned: boolean) => void;
  readonly onSetPreferences: (next: VoiceUpdatePreferencesView) => void;
}
export declare function ModelUpdatesPanel({
  installations,
  preferences,
  isOwner,
  lastCheckedAt,
  checking,
  onCheckNow,
  onUpdateNow,
  onTogglePin,
  onSetPreferences,
}: ModelUpdatesPanelProps): import("react/jsx-runtime").JSX.Element;
/**
 * Standalone hook helper for callers that don't yet have a server route to
 * mount against — preserves the panel's contract (so storybooks render)
 * but tolerates absent endpoints.
 */
export declare function useStaticVoiceUpdatePreferences(
  initial?: VoiceUpdatePreferencesView,
): {
  preferences: VoiceUpdatePreferencesView;
  setPreferences: (next: VoiceUpdatePreferencesView) => void;
};
export default ModelUpdatesPanel;
//# sourceMappingURL=ModelUpdatesPanel.d.ts.map
