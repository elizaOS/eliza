import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@elizaos/ui";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  dispatchSecretsManagerOpen,
  useSecretsManagerModalState,
} from "../../hooks/useSecretsManagerModal";
import { getShortcutLabel } from "../../hooks/useSecretsManagerShortcut";
import { VaultInventoryPanel } from "./VaultInventoryPanel";

/**
 * Settings → Storage section.
 *
 * Two exports:
 *  - `SecretsManagerSection` — the inline launcher row in Settings.
 *    Shows current primary backend + status; clicking dispatches the
 *    global open event for the modal. Doesn't mount the modal itself.
 *  - `SecretsManagerModalRoot` — the modal's top-level mount. Should
 *    be rendered ONCE at app root (alongside SaveCommandModal etc.
 *    in App.tsx). Subscribes to global open/close state so any
 *    trigger (Settings launcher, ⌘⌥⌃V keyboard chord, application
 *    menu accelerator) shows it.
 *
 * Default: "in-house" only (Milady's local encrypted store). Users
 * additionally enable 1Password, Bitwarden, or Proton Pass and route
 * sensitive values to whichever they prefix; non-sensitive config
 * always stays in-house.
 *
 * For each external backend the row shows one of three states based on
 * `(available, signedIn)`:
 *   - `available: false`        → Install button (opens InstallSheet,
 *                                  streams the brew/npm install logs)
 *   - `available, !signedIn`    → Sign-in button (opens SigninSheet,
 *                                  collects credentials, persists session)
 *   - `available, signedIn`     → reorder + sign-out
 */

type BackendId = "in-house" | "1password" | "protonpass" | "bitwarden";
type InstallableBackendId = Exclude<BackendId, "in-house">;

interface BackendStatus {
  id: BackendId;
  label: string;
  available: boolean;
  signedIn?: boolean;
  detail?: string;
  /**
   * Auth path used by this backend: `desktop-app` (1Password 8 native
   * app integration), `session-token` (legacy stored session), or null
   * (not signed in / not applicable). Drives a badge on the row so the
   * user sees at a glance which mode is live.
   */
  authMode?: "desktop-app" | "session-token" | null;
}

interface ManagerPreferences {
  enabled: BackendId[];
  routing?: Record<string, BackendId>;
}

type InstallMethod =
  | { kind: "brew"; package: string; cask: boolean }
  | { kind: "npm"; package: string }
  | { kind: "manual"; instructions: string; url: string };

const BACKEND_ORDER: BackendId[] = [
  "in-house",
  "1password",
  "bitwarden",
  "protonpass",
];

// ── Public components ──────────────────────────────────────────────

export function SecretsManagerSection() {
  const [primary, setPrimary] = useState<BackendStatus | null>(null);
  const [enabledCount, setEnabledCount] = useState<number>(1);
  const { isOpen } = useSecretsManagerModalState();

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
      /* network errors fall through; UI shows the default fallback */
    }
  }, []);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    if (!isOpen) void refreshSummary();
  }, [isOpen, refreshSummary]);

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
              <span className="ml-1 text-muted/70">({getShortcutLabel()})</span>
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0 rounded-lg"
          onClick={() => dispatchSecretsManagerOpen()}
        >
          Manage…
        </Button>
      </div>
    </section>
  );
}

export function SecretsManagerModalRoot() {
  const { isOpen, setOpen } = useSecretsManagerModalState();
  return <SecretsManagerModal open={isOpen} onOpenChange={setOpen} />;
}

export function SecretsManagerModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [backends, setBackends] = useState<BackendStatus[] | null>(null);
  const [preferences, setPreferences] = useState<ManagerPreferences | null>(
    null,
  );
  const [installMethods, setInstallMethods] = useState<Record<
    InstallableBackendId,
    InstallMethod[]
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Inline-sheet state for install / sign-in. Only one of these is non-null
  // at any time — both render in BackendRow as expanded sub-panels.
  const [installSheet, setInstallSheet] = useState<InstallableBackendId | null>(
    null,
  );
  const [signinSheet, setSigninSheet] = useState<InstallableBackendId | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bRes, pRes, mRes] = await Promise.all([
        fetch("/api/secrets/manager/backends"),
        fetch("/api/secrets/manager/preferences"),
        fetch("/api/secrets/manager/install/methods"),
      ]);
      if (!bRes.ok) throw new Error(`backends: HTTP ${bRes.status}`);
      if (!pRes.ok) throw new Error(`preferences: HTTP ${pRes.status}`);
      if (!mRes.ok) throw new Error(`install/methods: HTTP ${mRes.status}`);
      const bJson = (await bRes.json()) as { backends: BackendStatus[] };
      const pJson = (await pRes.json()) as { preferences: ManagerPreferences };
      const mJson = (await mRes.json()) as {
        methods: Record<InstallableBackendId, InstallMethod[]>;
      };
      setBackends(bJson.backends);
      setPreferences(pJson.preferences);
      setInstallMethods(mJson.methods);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Clear the "Saved" label after 2.5s. Without this, the button reads
  // "Saved" until the next state change because nothing else triggers a
  // re-render once the time-based comparison flips false.
  useEffect(() => {
    if (savedAt === null) return;
    const id = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(id);
  }, [savedAt]);

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

  const onInstallComplete = useCallback(() => {
    setInstallSheet(null);
    void load();
  }, [load]);

  const onSigninComplete = useCallback(() => {
    setSigninSheet(null);
    void load();
  }, [load]);

  const onSignout = useCallback(
    async (backendId: InstallableBackendId) => {
      try {
        const res = await fetch("/api/secrets/manager/signout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backendId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "sign-out failed");
      }
    },
    [load],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted" aria-hidden />
              Secrets storage
            </span>
            <span className="rounded-md border border-border/50 bg-bg/40 px-2 py-0.5 font-mono text-2xs font-normal text-muted">
              {getShortcutLabel()}
            </span>
          </DialogTitle>
          <DialogDescription>
            Pick where Milady stores your API keys and other sensitive values.
            Local storage is always available as the fallback.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
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
                    methods={
                      backend.id === "in-house"
                        ? []
                        : (installMethods?.[
                            backend.id as InstallableBackendId
                          ] ?? [])
                    }
                    installSheetOpen={installSheet === backend.id}
                    signinSheetOpen={signinSheet === backend.id}
                    onToggle={(on) => setEnabled(backend.id, on)}
                    onMoveUp={() => moveUp(backend.id)}
                    onMoveDown={() => moveDown(backend.id)}
                    onOpenInstallSheet={() =>
                      setInstallSheet(backend.id as InstallableBackendId)
                    }
                    onOpenSigninSheet={() =>
                      setSigninSheet(backend.id as InstallableBackendId)
                    }
                    onCloseSheets={() => {
                      setInstallSheet(null);
                      setSigninSheet(null);
                    }}
                    onInstallComplete={onInstallComplete}
                    onSigninComplete={onSigninComplete}
                    onSignout={() =>
                      onSignout(backend.id as InstallableBackendId)
                    }
                  />
                ))}
              </div>

              <VaultInventoryPanel />

              <SavedLoginsPanel />
            </>
          )}
        </div>

        <DialogFooter className="flex shrink-0 flex-row items-center justify-between gap-3 border-t border-border/30 pt-3 sm:justify-between">
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
              {saving ? "Saving…" : savedAt !== null ? "Saved" : "Save"}
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

interface BackendRowProps {
  backend: BackendStatus;
  enabled: boolean;
  isPrimary: boolean;
  position: number;
  totalEnabled: number;
  methods: readonly InstallMethod[];
  installSheetOpen: boolean;
  signinSheetOpen: boolean;
  onToggle: (on: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onOpenInstallSheet: () => void;
  onOpenSigninSheet: () => void;
  onCloseSheets: () => void;
  onInstallComplete: () => void;
  onSigninComplete: () => void;
  onSignout: () => void;
}

export function BackendRow(props: BackendRowProps) {
  const {
    backend,
    enabled,
    isPrimary,
    position,
    totalEnabled,
    methods,
    installSheetOpen,
    signinSheetOpen,
    onToggle,
    onMoveUp,
    onMoveDown,
    onOpenInstallSheet,
    onOpenSigninSheet,
    onCloseSheets,
    onInstallComplete,
    onSigninComplete,
    onSignout,
  } = props;
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
  const isInstallable = !lockedInHouse;
  const showInstallButton = isInstallable && !backend.available;
  const showSigninButton =
    isInstallable && backend.available && backend.signedIn === false;
  const showSignoutButton =
    isInstallable && backend.available && backend.signedIn === true;
  const installableId = backend.id as InstallableBackendId;

  return (
    <div
      className={`rounded-lg border bg-card/35 px-3 py-2.5 ${
        enabled ? "border-border" : "border-border/40 opacity-70"
      }`}
    >
      <div className="flex items-center gap-3">
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
            {backend.authMode === "desktop-app" && (
              <span
                data-testid={`auth-mode-badge-${backend.id}`}
                className="rounded-full border border-info/40 bg-info/10 px-1.5 py-0.5 text-2xs font-medium text-info"
                title="Authenticated via 1Password desktop app"
              >
                via desktop app
              </span>
            )}
            {isPrimary && enabled && (
              <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                Primary
              </span>
            )}
          </div>
          {backend.detail && (
            <p className="mt-0.5 truncate text-2xs text-muted">
              {backend.detail}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {showInstallButton && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-md px-2 text-xs"
              onClick={onOpenInstallSheet}
              aria-label={`Install ${backend.label}`}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Install
            </Button>
          )}
          {showSigninButton && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-md px-2 text-xs"
              onClick={onOpenSigninSheet}
              aria-label={`Sign in to ${backend.label}`}
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden />
              Sign in
            </Button>
          )}
          {showSignoutButton && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-md px-2 text-xs text-muted"
              onClick={onSignout}
              aria-label={`Sign out of ${backend.label}`}
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              Sign out
            </Button>
          )}
          {enabled && backend.available && backend.signedIn !== false && (
            <>
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
            </>
          )}
        </div>
      </div>

      {isInstallable && installSheetOpen && (
        <InstallSheet
          backendId={installableId}
          backendLabel={backend.label}
          methods={methods}
          onCancel={onCloseSheets}
          onComplete={onInstallComplete}
        />
      )}
      {isInstallable && signinSheetOpen && (
        <SigninSheet
          backendId={installableId}
          backendLabel={backend.label}
          onCancel={onCloseSheets}
          onComplete={onSigninComplete}
        />
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

// ── Install sheet ──────────────────────────────────────────────────

interface InstallSheetProps {
  backendId: InstallableBackendId;
  backendLabel: string;
  methods: readonly InstallMethod[];
  onCancel: () => void;
  onComplete: () => void;
}

export function InstallSheet({
  backendId,
  backendLabel,
  methods,
  onCancel,
  onComplete,
}: InstallSheetProps) {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    onCancel();
  }, [onCancel]);

  // Close any open SSE on unmount.
  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (method: InstallMethod) => {
      if (method.kind === "manual") {
        // Manual — open the docs and bail. No automated path.
        window.open(method.url, "_blank", "noopener,noreferrer");
        return;
      }
      setRunning(true);
      setLogs([]);
      setError(null);
      setDone(false);
      try {
        const res = await fetch("/api/secrets/manager/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backendId, method }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const { jobId } = (await res.json()) as { jobId: string };

        const source = new EventSource(`/api/secrets/manager/install/${jobId}`);
        sourceRef.current = source;
        source.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as
              | {
                  type: "log";
                  stream: "stdout" | "stderr";
                  line: string;
                }
              | { type: "status"; status: string }
              | { type: "done"; exitCode: number }
              | { type: "error"; message: string };
            if (data.type === "log") {
              setLogs((prev) => [...prev.slice(-199), data.line]);
            } else if (data.type === "done") {
              setDone(true);
              setRunning(false);
              source.close();
              sourceRef.current = null;
            } else if (data.type === "error") {
              setError(data.message);
              setRunning(false);
              source.close();
              sourceRef.current = null;
            }
          } catch {
            // Ignore malformed events; the stream is best-effort.
          }
        };
        source.onerror = () => {
          // Server closed the stream after a terminal event; not fatal
          // unless we never got `done` or `error`.
          if (!sourceRef.current) return;
          source.close();
          sourceRef.current = null;
          if (!done && !error) {
            setError("install stream disconnected");
            setRunning(false);
          }
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : "install failed");
        setRunning(false);
      }
    },
    [backendId, done, error],
  );

  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border/50 bg-bg/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-txt">Install {backendLabel}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 rounded-md px-2 text-2xs"
          onClick={close}
          disabled={running}
        >
          Close
        </Button>
      </div>

      {!running && !done && (
        <div className="space-y-1.5">
          {methods.length === 0 ? (
            <p className="text-2xs text-muted">
              No automated installer is available on this OS for {backendLabel}.
              The vendor's CLI may need a manual install.
            </p>
          ) : (
            methods.map((m) => (
              <Button
                key={methodKey(m)}
                variant="outline"
                size="sm"
                className="h-8 w-full justify-start gap-2 rounded-md"
                onClick={() => void start(m)}
              >
                {m.kind === "manual" ? (
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden />
                )}
                <span className="truncate text-xs">{describeMethod(m)}</span>
              </Button>
            ))
          )}
        </div>
      )}

      {running && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Installing…
          </div>
          {lastLog && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded border border-border/40 bg-card/40 p-2 text-2xs text-muted">
              {lastLog}
            </pre>
          )}
        </div>
      )}

      {done && !error && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-ok/30 bg-ok/10 px-2 py-1.5 text-xs text-ok">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Install complete.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-md px-2 text-2xs"
            onClick={onComplete}
          >
            Continue
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function methodKey(method: InstallMethod): string {
  if (method.kind === "brew") {
    return `brew:${method.cask ? "cask" : "formula"}:${method.package}`;
  }
  if (method.kind === "npm") {
    return `npm:${method.package}`;
  }
  return `manual:${method.url}`;
}

function describeMethod(method: InstallMethod): string {
  if (method.kind === "brew") {
    return method.cask
      ? `brew install --cask ${method.package}`
      : `brew install ${method.package}`;
  }
  if (method.kind === "npm") {
    return `npm install -g ${method.package}`;
  }
  return `Open docs: ${method.url}`;
}

// ── Sign-in sheet ──────────────────────────────────────────────────

interface SigninSheetProps {
  backendId: InstallableBackendId;
  backendLabel: string;
  onCancel: () => void;
  onComplete: () => void;
}

export function SigninSheet({
  backendId,
  backendLabel,
  onCancel,
  onComplete,
}: SigninSheetProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [signInAddress, setSignInAddress] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [bwClientId, setBwClientId] = useState("");
  const [bwClientSecret, setBwClientSecret] = useState("");

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        backendId,
        masterPassword,
      };
      if (backendId === "1password") {
        body.email = email;
        body.secretKey = secretKey;
        if (signInAddress.trim()) body.signInAddress = signInAddress.trim();
      } else if (backendId === "bitwarden") {
        body.bitwardenClientId = bwClientId;
        body.bitwardenClientSecret = bwClientSecret;
      }
      const res = await fetch("/api/secrets/manager/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign-in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mt-3 space-y-2 rounded-md border border-border/50 bg-bg/30 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-txt">
          Sign in to {backendLabel}
        </p>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="h-6 rounded-md px-2 text-2xs"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>

      {backendId === "1password" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="op-email" className="text-2xs text-muted">
              Email
            </Label>
            <Input
              id="op-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="op-secret-key" className="text-2xs text-muted">
              Secret key (34 chars)
            </Label>
            <Input
              id="op-secret-key"
              type="text"
              required
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="op-address" className="text-2xs text-muted">
              Sign-in address (optional, e.g. my.1password.com)
            </Label>
            <Input
              id="op-address"
              type="text"
              value={signInAddress}
              onChange={(e) => setSignInAddress(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </>
      )}

      {backendId === "bitwarden" && (
        <>
          <p className="text-2xs text-muted">
            Bitwarden requires API key credentials for non-interactive sign-in.
            Create one at Settings → Security → Keys → API key.
          </p>
          <div className="space-y-1">
            <Label htmlFor="bw-client-id" className="text-2xs text-muted">
              client_id (BW_CLIENTID)
            </Label>
            <Input
              id="bw-client-id"
              type="text"
              required
              value={bwClientId}
              onChange={(e) => setBwClientId(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bw-client-secret" className="text-2xs text-muted">
              client_secret (BW_CLIENTSECRET)
            </Label>
            <Input
              id="bw-client-secret"
              type="password"
              autoComplete="off"
              required
              value={bwClientSecret}
              onChange={(e) => setBwClientSecret(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
        </>
      )}

      {backendId === "protonpass" && (
        <p className="text-2xs text-warn">
          Proton Pass CLI is in closed beta — automated sign-in is not yet
          supported.
        </p>
      )}

      <div className="space-y-1">
        <Label htmlFor="master-password" className="text-2xs text-muted">
          Master password
        </Label>
        <Input
          id="master-password"
          type="password"
          autoComplete="current-password"
          required
          value={masterPassword}
          onChange={(e) => setMasterPassword(e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="submit"
          variant="default"
          size="sm"
          className="h-7 gap-1 rounded-md px-3 text-xs"
          disabled={submitting || backendId === "protonpass"}
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Signing in…
            </>
          ) : (
            <>
              <LogIn className="h-3.5 w-3.5" aria-hidden />
              Sign in
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

// ── Saved logins panel ──────────────────────────────────────────────
//
// Aggregates logins from every signed-in backend (in-house vault,
// 1Password, Bitwarden) into one list. Each row shows a source pill so
// the user can see where a credential came from. External rows are
// read-only — managing them happens in the password manager itself —
// while the in-house "Add login" form persists to the vault.

type SavedLoginSource = "in-house" | "1password" | "bitwarden";

interface UnifiedSavedLogin {
  source: SavedLoginSource;
  identifier: string;
  domain: string | null;
  username: string;
  title: string;
  updatedAt: number;
}

interface SavedLoginsListFailure {
  source: "1password" | "bitwarden";
  message: string;
}

const SOURCE_LABEL: Record<SavedLoginSource, string> = {
  "in-house": "Local",
  "1password": "1Password",
  bitwarden: "Bitwarden",
};

const SOURCE_PILL_CLASS: Record<SavedLoginSource, string> = {
  "in-house": "border-accent/40 bg-accent/10 text-accent",
  "1password": "border-info/40 bg-info/10 text-info",
  bitwarden: "border-warn/40 bg-warn/10 text-warn",
};

function relativeAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const elapsed = Date.now() - ms;
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function SavedLoginsPanel() {
  const [logins, setLogins] = useState<UnifiedSavedLogin[] | null>(null);
  const [failures, setFailures] = useState<SavedLoginsListFailure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addDomain, setAddDomain] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setError(null);
    setLogins(null);
    try {
      const res = await fetch("/api/secrets/logins");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        logins: UnifiedSavedLogin[];
        failures?: SavedLoginsListFailure[];
      };
      setLogins(json.logins);
      setFailures(json.failures ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
      setLogins([]);
      setFailures([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAdd = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!addDomain.trim() || !addUsername || !addPassword) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/secrets/logins", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            domain: addDomain.trim(),
            username: addUsername,
            password: addPassword,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setAddDomain("");
        setAddUsername("");
        setAddPassword("");
        setShowAdd(false);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "save failed");
      } finally {
        setSubmitting(false);
      }
    },
    [addDomain, addUsername, addPassword, load],
  );

  const onDelete = useCallback(
    async (login: UnifiedSavedLogin) => {
      // Only in-house entries can be deleted from this UI; external
      // rows omit the delete affordance entirely.
      if (login.source !== "in-house") return;
      const ok = window.confirm(
        `Delete saved login for ${login.domain ?? "—"} (${login.username})?`,
      );
      if (!ok) return;
      setError(null);
      try {
        const colon = login.identifier.indexOf(":");
        const domainPart = colon > 0 ? login.identifier.slice(0, colon) : "";
        const userPart = colon > 0 ? login.identifier.slice(colon + 1) : "";
        const path = `/api/secrets/logins/${encodeURIComponent(domainPart)}/${encodeURIComponent(userPart)}`;
        const res = await fetch(path, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "delete failed");
      }
    },
    [load],
  );

  const filtered = (logins ?? []).filter((l) => {
    if (filter.trim().length === 0) return true;
    const needle = filter.trim().toLowerCase();
    return (
      l.title.toLowerCase().includes(needle) ||
      l.username.toLowerCase().includes(needle) ||
      (l.domain ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <section
      data-testid="saved-logins-panel"
      className="space-y-2 border-t border-border/30 pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-txt">Saved logins</p>
          <p className="text-2xs text-muted">
            Browser autofill from local vault, 1Password, and Bitwarden.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 rounded-md px-2"
          onClick={() => setShowAdd((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add login
        </Button>
      </div>

      {error && (
        <div
          aria-live="polite"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger"
        >
          {error}
        </div>
      )}

      {failures.length > 0 && (
        <div
          aria-live="polite"
          data-testid="saved-logins-failures"
          className="space-y-1"
        >
          {failures.map((f) => (
            <div
              key={f.source}
              className="rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 text-2xs text-warn"
            >
              {SOURCE_LABEL[f.source]} failed to load: {f.message}
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <form
          onSubmit={onAdd}
          className="space-y-2 rounded-md border border-border/50 bg-card/30 p-2"
          data-testid="saved-logins-add-form"
        >
          <p className="text-2xs text-muted">
            Saved to local (encrypted) vault. To add to 1Password or
            Bitwarden, use that app directly.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="text-2xs text-muted">Domain</Label>
              <Input
                value={addDomain}
                onChange={(e) => setAddDomain(e.target.value)}
                placeholder="github.com"
                className="h-8 text-xs"
                autoComplete="off"
                required
              />
            </div>
            <div>
              <Label className="text-2xs text-muted">Username / email</Label>
              <Input
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                placeholder="alice@example.com"
                className="h-8 text-xs"
                autoComplete="off"
                required
              />
            </div>
          </div>
          <div>
            <Label className="text-2xs text-muted">Password</Label>
            <Input
              type="password"
              value={addPassword}
              onChange={(e) => setAddPassword(e.target.value)}
              className="h-8 text-xs"
              autoComplete="new-password"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-md px-3 text-xs"
              onClick={() => setShowAdd(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="h-7 gap-1 rounded-md px-3 text-xs"
              disabled={
                submitting || !addDomain.trim() || !addUsername || !addPassword
              }
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </form>
      )}

      {logins !== null && logins.length > 0 && (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, user, or domain"
          className="h-8 text-xs"
          autoComplete="off"
          data-testid="saved-logins-filter"
        />
      )}

      {logins === null ? (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading…
        </div>
      ) : logins.length === 0 ? (
        <div
          data-testid="saved-logins-empty"
          className="rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
        >
          No saved logins yet. Add one here, or sign in to 1Password /
          Bitwarden above to surface their entries.
        </div>
      ) : filtered.length === 0 ? (
        <div
          data-testid="saved-logins-no-match"
          className="rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-3 text-center text-xs text-muted"
        >
          No logins match "{filter}".
        </div>
      ) : (
        <ul
          data-testid="saved-logins-list"
          className="space-y-1 rounded-md border border-border/40 bg-card/30 p-1"
        >
          {filtered.map((login) => (
            <li
              key={`${login.source}:${login.identifier}`}
              className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-bg-muted/30"
            >
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-2xs font-medium ${SOURCE_PILL_CLASS[login.source]}`}
              >
                {SOURCE_LABEL[login.source]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-txt">
                  {login.title}
                  {login.domain && login.domain !== login.title ? (
                    <span className="ml-1.5 text-muted">({login.domain})</span>
                  ) : null}
                </p>
                <p className="truncate text-2xs text-muted">
                  {login.username || "—"} · {relativeAge(login.updatedAt)}
                </p>
              </div>
              {login.source === "in-house" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 shrink-0 rounded-md p-0 text-muted hover:text-danger"
                  aria-label={`Delete saved login for ${login.domain ?? login.username}`}
                  onClick={() => void onDelete(login)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : (
                <ExternalRowAction login={login} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExternalRowAction({ login }: { login: UnifiedSavedLogin }) {
  // External rows are read-only. The "view" action sends the user back to
  // their password manager — they manage the entry there.
  const href =
    login.source === "1password"
      ? `https://my.1password.com/vaults/all/allitems/${encodeURIComponent(login.identifier)}`
      : "https://vault.bitwarden.com/";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/40 px-2 text-2xs text-muted hover:text-txt"
      aria-label={`View in ${SOURCE_LABEL[login.source]}`}
      title={`View in ${SOURCE_LABEL[login.source]}`}
    >
      <ExternalLink className="h-3 w-3" aria-hidden />
      View
    </a>
  );
}
