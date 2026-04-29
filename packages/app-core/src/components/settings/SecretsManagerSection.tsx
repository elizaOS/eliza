import { Button } from "@elizaos/ui";
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
 * Lets a user pick which password manager(s) Milady routes secrets
 * through. The default is "in-house" (local, encrypted with the OS
 * keychain master key). Users can additionally enable 1Password,
 * Bitwarden, or Proton Pass; sensitive values then route to the
 * first enabled backend, falling back to in-house when one isn't
 * available.
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

export function SecretsManagerSection() {
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
    void load();
  }, [load]);

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
      // Keep priority order from BACKEND_ORDER, with previously-enabled
      // ones preserved at their position relative to the rest.
      const ordered = preferences.enabled.filter((b) => next.has(b));
      for (const id2 of next) {
        if (!ordered.includes(id2)) ordered.push(id2);
      }
      // in-house is the implicit fallback; keep it at the end if not
      // explicitly set.
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

  if (loading || !backends || !preferences) {
    return (
      <section className="space-y-3">
        <Header />
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </section>
    );
  }

  // Render order: enabled backends first (in priority order), then disabled.
  const enabledList = preferences.enabled
    .map((id) => backends.find((b) => b.id === id))
    .filter((b): b is BackendStatus => b !== undefined);
  const disabledList = backends.filter(
    (b) => !preferences.enabled.includes(b.id),
  );
  const sortedDisabled = BACKEND_ORDER.map((id) =>
    disabledList.find((b) => b.id === id),
  ).filter((b): b is BackendStatus => b !== undefined);
  const ordered = [...enabledList, ...sortedDisabled];

  return (
    <section className="space-y-3">
      <Header onRefresh={load} />

      {error && (
        <div
          aria-live="polite"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        {ordered.map((backend, idx) => (
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
            isLast={idx === ordered.length - 1}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-2xs text-muted">
          Sensitive values route to the first enabled backend; non-sensitive
          config always stays in-house.
        </p>
        <Button
          variant="default"
          size="sm"
          className="h-9 rounded-lg font-semibold"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving
            ? "Saving…"
            : savedAt && Date.now() - savedAt < 2500
              ? "Saved"
              : "Save"}
        </Button>
      </div>
    </section>
  );
}

function Header({ onRefresh }: { onRefresh?: () => void }) {
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted" aria-hidden />
        <h2 className="font-semibold text-sm text-txt">Secrets storage</h2>
      </div>
      {onRefresh && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-md px-2"
          onClick={onRefresh}
          aria-label="Re-detect backends"
          title="Re-detect backends"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        </Button>
      )}
    </header>
  );
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
  isLast: boolean;
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
  const lockedInHouse = backend.id === "in-house"; // can't disable the fallback
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
