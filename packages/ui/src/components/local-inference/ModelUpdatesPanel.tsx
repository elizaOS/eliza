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

import {
  latestVoiceModelVersion,
  VOICE_MODEL_VERSIONS,
  type VoiceModelId,
  type VoiceModelVersion,
} from "@elizaos/shared";
import { useMemo, useState } from "react";
import { Button } from "../ui/button";

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

/** Format bytes as MB (1 decimal). Used for the per-asset size hint. */
function formatMb(bytes: number): string {
  if (bytes <= 0) return "(unpublished)";
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function totalBytes(latest: VoiceModelVersion | undefined): number {
  if (!latest) return 0;
  return latest.ggufAssets.reduce((s, a) => s + a.sizeBytes, 0);
}

function formatLastChecked(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString();
}

export function ModelUpdatesPanel({
  installations,
  preferences,
  isOwner,
  lastCheckedAt,
  checking = false,
  onCheckNow,
  onUpdateNow,
  onTogglePin,
  onSetPreferences,
}: ModelUpdatesPanelProps) {
  // Build a per-id view of the catalog: installed + latest + pinned.
  const rows = useMemo(() => {
    const installedMap = new Map<VoiceModelId, VoiceModelInstallationView>();
    for (const inst of installations) installedMap.set(inst.id, inst);
    const ids = new Set<VoiceModelId>(VOICE_MODEL_VERSIONS.map((v) => v.id));
    for (const inst of installations) ids.add(inst.id);
    const list = Array.from(ids).sort();
    return list.map((id) => {
      const installation = installedMap.get(id);
      const latest = latestVoiceModelVersion(id);
      return {
        id,
        installedVersion: installation?.installedVersion ?? null,
        pinned: installation?.pinned ?? false,
        lastError: installation?.lastError ?? null,
        latest,
        downloadBytes: totalBytes(latest),
        updateAvailable:
          installation?.installedVersion != null &&
          latest != null &&
          latest.version !== installation.installedVersion,
      };
    });
  }, [installations]);

  return (
    <section className="rounded-xl border border-border p-4 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div>
          <h3 className="text-base font-semibold">Model Updates</h3>
          <p className="text-xs text-muted-foreground">
            Voice sub-models check every 4h. Last checked:{" "}
            {formatLastChecked(lastCheckedAt)}.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCheckNow}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check now"}
        </Button>
      </header>

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <ModelUpdateCard
            key={row.id}
            row={row}
            onUpdateNow={onUpdateNow}
            onTogglePin={onTogglePin}
          />
        ))}
      </div>

      <footer className="mt-4 flex flex-wrap items-center gap-4 border-t border-border pt-3 text-xs">
        <ToggleRow
          label="Auto-update on Wi-Fi"
          checked={preferences.autoUpdateOnWifi}
          onChange={(next) =>
            onSetPreferences({ ...preferences, autoUpdateOnWifi: next })
          }
        />
        <ToggleRow
          label="Auto-update on cellular"
          checked={preferences.autoUpdateOnCellular}
          disabled={!isOwner}
          hint={!isOwner ? "Owner only" : undefined}
          onChange={(next) =>
            onSetPreferences({ ...preferences, autoUpdateOnCellular: next })
          }
        />
        <ToggleRow
          label="Auto-update on metered link"
          checked={preferences.autoUpdateOnMetered}
          disabled={!isOwner}
          hint={!isOwner ? "Owner only" : undefined}
          onChange={(next) =>
            onSetPreferences({ ...preferences, autoUpdateOnMetered: next })
          }
        />
      </footer>
    </section>
  );
}

interface ModelUpdateCardProps {
  row: {
    id: VoiceModelId;
    installedVersion: string | null;
    pinned: boolean;
    lastError: string | null;
    latest: VoiceModelVersion | undefined;
    downloadBytes: number;
    updateAvailable: boolean;
  };
  onUpdateNow: ModelUpdatesPanelProps["onUpdateNow"];
  onTogglePin: ModelUpdatesPanelProps["onTogglePin"];
}

function ModelUpdateCard({
  row,
  onUpdateNow,
  onTogglePin,
}: ModelUpdateCardProps) {
  const versionLabel = row.latest
    ? row.updateAvailable
      ? `${row.installedVersion ?? "—"} → ${row.latest.version}`
      : row.installedVersion
        ? `up to date ${row.installedVersion}`
        : `${row.latest.version} (not installed)`
    : "no version data";
  return (
    <article className="rounded-lg border border-border p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-sm">{row.id}</div>
        <div className="text-xs text-muted-foreground">{versionLabel}</div>
      </header>
      {row.latest?.changelogEntry ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {row.latest.changelogEntry}
        </p>
      ) : null}
      {row.latest && row.downloadBytes > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Size: {formatMb(row.downloadBytes)}
        </p>
      ) : null}
      {row.lastError ? (
        <p className="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {row.lastError}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!row.updateAvailable || row.pinned}
          onClick={() => onUpdateNow(row.id)}
        >
          Update now
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onTogglePin(row.id, !row.pinned)}
        >
          {row.pinned ? "Unpin" : "Pin"}
        </Button>
      </div>
    </article>
  );
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (next: boolean) => void;
}

function ToggleRow({
  label,
  checked,
  disabled = false,
  hint,
  onChange,
}: ToggleRowProps) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>{label}</span>
      {hint ? <span className="text-muted-foreground">({hint})</span> : null}
    </label>
  );
}

/**
 * Standalone hook helper for callers that don't yet have a server route to
 * mount against — preserves the panel's contract (so storybooks render)
 * but tolerates absent endpoints.
 */
export function useStaticVoiceUpdatePreferences(
  initial?: VoiceUpdatePreferencesView,
): {
  preferences: VoiceUpdatePreferencesView;
  setPreferences: (next: VoiceUpdatePreferencesView) => void;
} {
  const [preferences, setPreferences] = useState<VoiceUpdatePreferencesView>(
    initial ?? {
      autoUpdateOnWifi: true,
      autoUpdateOnCellular: false,
      autoUpdateOnMetered: false,
    },
  );
  return { preferences, setPreferences };
}

export default ModelUpdatesPanel;
