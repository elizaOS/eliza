import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@elizaos/ui";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Settings → Storage section.
 *
 * Two parts:
 *  - `SecretsManagerSummary` — the inline Settings row. Shows current
 *    primary backend + status; clicking opens the manager modal. This
 *    is what mounts in SettingsView.
 *  - `SecretsManagerModal` — the actual UI for picking enabled
 *    backends and their priority. Controlled via `open` /
 *    `onOpenChange` so the summary row drives it.
 *
 * Default: "in-house" only (Milady's local encrypted store). Users
 * additionally enable 1Password, Bitwarden, or Proton Pass and route
 * sensitive values to whichever they prefer; non-sensitive config
 * always stays in-house.
 */

type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";

interface BackendStatus {
  id: BackendId;
  label: string;
  available: boolean;
  signedIn?: boolean;
  detail?: string;
}

interface ManagerPreferences {
  enabled: BackendId[];
  routing?: Record<string, BackendId>;
}

const BACKEND_ORDER: BackendId[] = [
  "in-house",
  "1password",
  "bitwarden",
  "protonpass",
];

// ── Public components ──────────────────────────────────────────────

/**
 * Inline summary row for Settings. Shows the current primary backend
 * + a "Manage…" button that opens the modal. Loads its own state so
 * the modal can stay closed by default.
 */
export function SecretsManagerSection() {
  const [open, setOpen] = useState(false);
  const [primary, setPrimary] = useState<BackendStatus | null>(null);
  const [enabledCount, setEnabledCount] = useState<number>(1);

  const refreshSummary = useCallback(async () => {
    try {
      const [bRes, pRes] = await Promise.all([
        fetch("/api/secrets/manager/backends"),
        fetch("/api/secrets/manager/preferences"),
      ]);
      if (!bRes.ok || !pRes.ok) return;
      const bJson = (await bRes.json()) as { backends: BackendStatus[] };
      const pJson = (await pRes.json()) as { preferences: ManagerPreferences };
      const primaryId = pJson.preferences.enabled[0] ?? "in-house";
      setPrimary(bJson.backends.find((b) => b.id === primaryId) ?? null);
      setEnabledCount(pJson.preferences.enabled.length);
    } catch {
      /* network errors fall through; UI shows "Unknown" */
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/50 text-muted">
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-sm text-txt">
                {primary?.label ?? "Local (encrypted)"}
              </span>
              {primary && (
                <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                  Primary
                </span>
              )}
              {enabledCount > 1 && (
                <span className="rounded-full border border-border/50 bg-bg/40 px-1.5 py-0.5 text-2xs text-muted">
                  +{enabledCount - 1} more
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-2xs text-muted">
              Where sensitive values like API keys are stored.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-lg"
          onClick={() => setOpen(true)}
        >
          Manage…
        </Button>
      </div>

      <SecretsManagerModal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) void refreshSummary();
        }}
      />
    </section>
  );
}

/**
 * Modal UI. Controlled — pass `open` and `onOpenChange`. Loads its own
 * data when `open` flips to true; saves on user click.
 */
export function SecretsManagerModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [backends, setBackends] = useState<BackendStatus[] | null>(null);
  const [preferences, setPreferences] = useState<ManagerPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bRes, pRes] = await Promise.all([
        fetch("/api/secrets/manager/backends"),
        fetch("/api/secrets/manager/preferences"),
      ]);
      if (!bRes.ok) throw new Error(`backends: HTTP ${bRes.status}`);
      if (!pRes.ok) throw new Error(`preferences: HTTP ${pRes.status}`);
      const bJson = (await bRes.json()) as { backends: BackendStatus[] };
      const pJson = (await pRes.json()) as { preferences: ManagerPreferences };
      setBackends(bJson.backends);
      setPreferences(pJson.preferences);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const isEnabled = useCallback(
    (id: BackendId): boolean =>
      preferences?.enabled.includes(id) ?? id === "in-house",
    [preferences],
  );

  const setEnabled = useCallback(
    (id: BackendId, on: boolean) => {
      if (!preferences) return;
      const next = new Set(preferences.enabled);
      if (on) next.add(id);
      else next.delete(id);
      const ordered = preferences.enabled.filter((b) => next.has(b));
      for (const id2 of next) {
        if (!ordered.includes(id2)) ordered.push(id2);
      }
      if (!ordered.includes("in-house")) ordered.push("in-house");
      setPreferences({ ...preferences, enabled: ordered });
    },
    [preferences],
  );

  const moveUp = useCallback(
    (id: BackendId) => {
      if (!preferences) return;
      const idx = preferences.enabled.indexOf(id);
      if (idx <= 0) return;
      const next = [...preferences.enabled];
      const swap = next[idx - 1];
      const cur = next[idx];
      if (!swap || !cur) return;
      next[idx - 1] = cur;
      next[idx] = swap;
      setPreferences({ ...preferences, enabled: next });
    },
    [preferences],
  );

  const moveDown = useCallback(
    (id: BackendId) => {
      if (!preferences) return;
      const idx = preferences.enabled.indexOf(id);
      if (idx < 0 || idx >= preferences.enabled.length - 1) return;
      const next = [...preferences.enabled];
      const swap = next[idx + 1];
      const cur = next[idx];
      if (!swap || !cur) return;
      next[idx + 1] = cur;
      next[idx] = swap;
      setPreferences({ ...preferences, enabled: next });
    },
    [preferences],
  );

  const save = useCallback(async () => {
    if (!preferences) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/secrets/manager/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferences }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { preferences: ManagerPreferences };
      setPreferences(json.preferences);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [preferences]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted" aria-hidden />
            Secrets storage
          </DialogTitle>
          <DialogDescription>
            Pick where Milady stores your API keys and other sensitive
            values. Local storage is always available as the fallback.
          </DialogDescription>
        </DialogHeader>

        {loading || !backends || !preferences ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </div>
        ) : (
          <>
            {error && (
              <div
                aria-live="polite"
                className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pb-1">
              <p className="text-2xs text-muted">
                Sensitive values route to the first enabled backend.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 rounded-md px-2"
                onClick={() => void load()}
                aria-label="Re-detect backends"
                title="Re-detect backends"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>

            <div className="space-y-1.5">
              {orderedBackends(backends, preferences).map((backend) => (
                <BackendRow
                  key={backend.id}
                  backend={backend}
                  enabled={isEnabled(backend.id)}
                  isPrimary={preferences.enabled[0] === backend.id}
                  position={preferences.enabled.indexOf(backend.id)}
                  totalEnabled={preferences.enabled.length}
                  onToggle={(on) => setEnabled(backend.id, on)}
                  onMoveUp={() => moveUp(backend.id)}
                  onMoveDown={() => moveDown(backend.id)}
                />
              ))}
            </div>
          </>
        )}

        <DialogFooter className="flex flex-row items-center justify-between gap-3 sm:justify-between">
          <p className="text-2xs text-muted sm:max-w-sm">
            Non-sensitive config always stays in-house.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-lg"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Close
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-9 rounded-lg font-semibold"
              onClick={() => void save()}
              disabled={saving || loading || !preferences}
            >
              {saving
                ? "Saving…"
                : savedAt && Date.now() - savedAt < 2500
                  ? "Saved"
                  : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Internal helpers ───────────────────────────────────────────────

function orderedBackends(
  backends: BackendStatus[],
  preferences: ManagerPreferences,
): BackendStatus[] {
  const enabledList = preferences.enabled
    .map((id) => backends.find((b) => b.id === id))
    .filter((b): b is BackendStatus => b !== undefined);
  const disabledList = backends.filter(
    (b) => !preferences.enabled.includes(b.id),
  );
  const sortedDisabled = BACKEND_ORDER.map((id) =>
    disabledList.find((b) => b.id === id),
  ).filter((b): b is BackendStatus => b !== undefined);
  return [...enabledList, ...sortedDisabled];
}

function BackendRow({
  backend,
  enabled,
  isPrimary,
  position,
  totalEnabled,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  backend: BackendStatus;
  enabled: boolean;
  isPrimary: boolean;
  position: number;
  totalEnabled: number;
  onToggle: (on: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const tone = backend.available
    ? backend.signedIn === false
      ? "warn"
      : "ok"
    : "muted";
  const status = backend.available
    ? backend.signedIn === false
      ? "Detected"
      : "Ready"
    : "Not detected";
  const lockedInHouse = backend.id === "in-house";
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border bg-card/35 px-3 py-2.5 ${
        enabled ? "border-border" : "border-border/40 opacity-70"
      }`}
    >
      <input
        type="checkbox"
        checked={enabled}
        disabled={lockedInHouse}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 cursor-pointer accent-accent disabled:cursor-not-allowed"
        aria-label={`Enable ${backend.label}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-txt">
            {backend.label}
          </span>
          <StatusPill tone={tone} text={status} />
          {isPrimary && enabled && (
            <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
              Primary
            </span>
          )}
        </div>
        {backend.detail && (
          <p className="mt-0.5 truncate text-2xs text-muted">{backend.detail}</p>
        )}
      </div>

      {enabled && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-md p-0"
            onClick={onMoveUp}
            disabled={position <= 0}
            title="Move up"
            aria-label="Move up"
          >
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-md p-0"
            onClick={onMoveDown}
            disabled={position < 0 || position >= totalEnabled - 1}
            title="Move down"
            aria-label="Move down"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusPill({
  tone,
  text,
}: {
  tone: "ok" | "warn" | "muted";
  text: string;
}) {
  const classes =
    tone === "ok"
      ? "border-ok/30 bg-ok/10 text-ok"
      : tone === "warn"
        ? "border-warn/30 bg-warn/10 text-warn"
        : "border-border/40 bg-bg/40 text-muted";
  const Icon = tone === "ok" ? CheckCircle2 : AlertCircle;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-2xs font-medium ${classes}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}
