/**
 * Overview tab — backends list, install / sign-in / sign-out, ordering,
 * and the "Save preferences" action. The parent Vault modal owns data
 * fetching and the save flow; this component only renders the rows + the
 * editable preference state.
 */

import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../../agent-surface";
// All requests go through the shared client (never bare `fetch`) so they hit
// the configured apiBase and carry the injected auth token — a bare relative
// fetch targets the page origin unauthenticated, which breaks remote/token-
// authed runtimes (e.g. the Android local agent).
import { client } from "../../../api/client";
import { useTranslation } from "../../../state/TranslationContext.hooks";
import { resolveApiUrl } from "../../../utils/asset-url";
import { openEventSource } from "../../../utils/event-source";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import type {
  BackendId,
  BackendStatus,
  InstallableBackendId,
  InstallMethod,
  ManagerPreferences,
} from "./types";

const BACKEND_ORDER: BackendId[] = [
  "in-house",
  "1password",
  "bitwarden",
  "protonpass",
];

export interface OverviewTabProps {
  backends: BackendStatus[];
  preferences: ManagerPreferences;
  installMethods: Record<InstallableBackendId, InstallMethod[]>;
  saving: boolean;
  savedAt: number | null;
  onPreferencesChange: (next: ManagerPreferences) => void;
  onSave: () => void;
  onReload: () => void;
  onInstallComplete: () => void;
  onSigninComplete: () => void;
  onSignout: (backendId: InstallableBackendId) => void;
}

export function OverviewTab(props: OverviewTabProps) {
  const {
    backends,
    preferences,
    installMethods,
    saving,
    savedAt,
    onPreferencesChange,
    onSave,
    onReload,
    onInstallComplete,
    onSigninComplete,
    onSignout,
  } = props;
  const { t } = useTranslation();

  const [installSheet, setInstallSheet] = useState<InstallableBackendId | null>(
    null,
  );
  const [signinSheet, setSigninSheet] = useState<InstallableBackendId | null>(
    null,
  );

  const { ref: redetectRef, agentProps: redetectAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "vault-overview-redetect",
      role: "button",
      label: "Re-detect backends",
      group: "vault-overview",
      description: "Re-scan the system for installed secret backends",
      onActivate: onReload,
    });
  const { ref: saveRef, agentProps: saveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "vault-overview-save",
      role: "button",
      label: "Save backend preferences",
      group: "vault-overview",
      description: "Persist the enabled backends and their routing order",
      onActivate: onSave,
    });

  const isEnabled = useCallback(
    (id: BackendId): boolean =>
      preferences.enabled.includes(id) || id === "in-house",
    [preferences],
  );

  const setEnabled = useCallback(
    (id: BackendId, on: boolean) => {
      const next = new Set(preferences.enabled);
      if (on) next.add(id);
      else next.delete(id);
      const ordered = preferences.enabled.filter((b) => next.has(b));
      for (const id2 of next) {
        if (!ordered.includes(id2)) ordered.push(id2);
      }
      if (!ordered.includes("in-house")) ordered.push("in-house");
      onPreferencesChange({ ...preferences, enabled: ordered });
    },
    [preferences, onPreferencesChange],
  );

  const moveUp = useCallback(
    (id: BackendId) => {
      const idx = preferences.enabled.indexOf(id);
      if (idx <= 0) return;
      const next = [...preferences.enabled];
      const swap = next[idx - 1];
      const cur = next[idx];
      if (!swap || !cur) return;
      next[idx - 1] = cur;
      next[idx] = swap;
      onPreferencesChange({ ...preferences, enabled: next });
    },
    [preferences, onPreferencesChange],
  );

  const moveDown = useCallback(
    (id: BackendId) => {
      const idx = preferences.enabled.indexOf(id);
      if (idx < 0 || idx >= preferences.enabled.length - 1) return;
      const next = [...preferences.enabled];
      const swap = next[idx + 1];
      const cur = next[idx];
      if (!swap || !cur) return;
      next[idx + 1] = cur;
      next[idx] = swap;
      onPreferencesChange({ ...preferences, enabled: next });
    },
    [preferences, onPreferencesChange],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between pb-1">
        <p className="text-2xs text-muted">
          {t("vault.overview.routeHint", {
            defaultValue:
              "Sensitive values route to the first enabled backend.",
          })}
        </p>
        <Button
          ref={redetectRef}
          {...redetectAgentProps}
          variant="ghost"
          size="sm"
          className="h-7 rounded-sm px-2"
          onClick={onReload}
          aria-label={t("vault.overview.redetect", {
            defaultValue: "Re-detect backends",
          })}
          title={t("vault.overview.redetect", {
            defaultValue: "Re-detect backends",
          })}
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
                : (installMethods[backend.id as InstallableBackendId] ?? [])
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
            onInstallComplete={() => {
              setInstallSheet(null);
              onInstallComplete();
            }}
            onSigninComplete={() => {
              setSigninSheet(null);
              onSigninComplete();
            }}
            onSignout={() => onSignout(backend.id as InstallableBackendId)}
          />
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/30 pt-2">
        <Button
          ref={saveRef}
          {...saveAgentProps}
          variant="default"
          size="sm"
          className="h-8 rounded-sm font-semibold"
          onClick={onSave}
          disabled={saving}
        >
          {saving
            ? t("vault.overview.saving", { defaultValue: "Saving…" })
            : savedAt !== null
              ? t("vault.overview.saved", { defaultValue: "Saved" })
              : t("vault.overview.savePreferences", {
                  defaultValue: "Save preferences",
                })}
        </Button>
      </div>
    </div>
  );
}

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
  const { t } = useTranslation();
  const { ref: enableRef, agentProps: enableAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-backend-enable-${backend.id}`,
      role: "toggle",
      label: `Enable ${backend.label} backend`,
      group: "vault-overview",
      status: enabled ? "active" : "inactive",
    });
  const { ref: installRef, agentProps: installAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-backend-install-${backend.id}`,
      role: "button",
      label: `Install ${backend.label}`,
      group: "vault-overview",
      onActivate: onOpenInstallSheet,
    });
  const { ref: signinRef, agentProps: signinAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-backend-signin-${backend.id}`,
      role: "button",
      label: `Sign in to ${backend.label}`,
      group: "vault-overview",
      onActivate: onOpenSigninSheet,
    });
  const { ref: signoutRef, agentProps: signoutAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-backend-signout-${backend.id}`,
      role: "button",
      label: `Sign out of ${backend.label}`,
      group: "vault-overview",
      onActivate: onSignout,
    });
  const { ref: moveUpRef, agentProps: moveUpAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-backend-move-up-${backend.id}`,
      role: "button",
      label: `Move ${backend.label} up in routing order`,
      group: "vault-overview",
      onActivate: onMoveUp,
    });
  const { ref: moveDownRef, agentProps: moveDownAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-backend-move-down-${backend.id}`,
      role: "button",
      label: `Move ${backend.label} down in routing order`,
      group: "vault-overview",
      onActivate: onMoveDown,
    });
  const tone = backend.available
    ? backend.signedIn === false
      ? "warn"
      : "ok"
    : "muted";
  const status = backend.available
    ? backend.signedIn === false
      ? t("vault.backend.status.detected", { defaultValue: "Detected" })
      : t("vault.backend.status.ready", { defaultValue: "Ready" })
    : t("vault.backend.status.notDetected", {
        defaultValue: "Not detected",
      });
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
      className={`rounded-sm border bg-card/35 px-3 py-2.5 ${
        enabled ? "border-border" : "border-border/40 opacity-70"
      }`}
    >
      <div className="flex items-center gap-3">
        <Input
          ref={enableRef}
          {...enableAgentProps}
          type="checkbox"
          checked={enabled}
          disabled={lockedInHouse}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 cursor-pointer border-border p-0 accent-accent disabled:cursor-not-allowed"
          aria-label={t("vault.backend.enableLabel", {
            label: backend.label,
            defaultValue: "Enable {{label}}",
          })}
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
                className="rounded-full border border-status-info/40 bg-status-info/10 px-1.5 py-0.5 text-2xs font-medium text-status-info"
                title={t("vault.backend.desktopAppTitle", {
                  defaultValue: "Authenticated via 1Password desktop app",
                })}
              >
                {t("vault.backend.viaDesktopApp", {
                  defaultValue: "via desktop app",
                })}
              </span>
            )}
            {isPrimary && enabled && (
              <span className="rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent">
                {t("vault.backend.primary", { defaultValue: "Primary" })}
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
              ref={installRef}
              {...installAgentProps}
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-sm px-2 text-xs"
              onClick={onOpenInstallSheet}
              aria-label={t("vault.backend.installLabel", {
                label: backend.label,
                defaultValue: "Install {{label}}",
              })}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {t("vault.backend.install", { defaultValue: "Install" })}
            </Button>
          )}
          {showSigninButton && (
            <Button
              ref={signinRef}
              {...signinAgentProps}
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-sm px-2 text-xs"
              onClick={onOpenSigninSheet}
              aria-label={t("vault.backend.signInLabel", {
                label: backend.label,
                defaultValue: "Sign in to {{label}}",
              })}
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden />
              {t("vault.backend.signIn", { defaultValue: "Sign in" })}
            </Button>
          )}
          {showSignoutButton && (
            <Button
              ref={signoutRef}
              {...signoutAgentProps}
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-sm px-2 text-xs text-muted"
              onClick={onSignout}
              aria-label={t("vault.backend.signOutLabel", {
                label: backend.label,
                defaultValue: "Sign out of {{label}}",
              })}
              title={t("vault.backend.signOut", { defaultValue: "Sign out" })}
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden />
              {t("vault.backend.signOut", { defaultValue: "Sign out" })}
            </Button>
          )}
          {enabled && backend.available && backend.signedIn !== false && (
            <>
              <Button
                ref={moveUpRef}
                {...moveUpAgentProps}
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-sm p-0"
                onClick={onMoveUp}
                disabled={position <= 0}
                title={t("vault.backend.moveUp", { defaultValue: "Move up" })}
                aria-label={t("vault.backend.moveUp", {
                  defaultValue: "Move up",
                })}
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <Button
                ref={moveDownRef}
                {...moveDownAgentProps}
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-sm p-0"
                onClick={onMoveDown}
                disabled={position < 0 || position >= totalEnabled - 1}
                title={t("vault.backend.moveDown", {
                  defaultValue: "Move down",
                })}
                aria-label={t("vault.backend.moveDown", {
                  defaultValue: "Move down",
                })}
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
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  const { ref: closeRef, agentProps: closeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-install-close-${backendId}`,
      role: "button",
      label: `Close ${backendLabel} install sheet`,
      group: "vault-install",
    });
  const { ref: continueRef, agentProps: continueAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-install-continue-${backendId}`,
      role: "button",
      label: "Continue after install",
      group: "vault-install",
      onActivate: onComplete,
    });

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (method: InstallMethod) => {
      if (method.kind === "manual") {
        window.open(method.url, "_blank", "noopener,noreferrer");
        return;
      }
      setRunning(true);
      setLogs([]);
      setError(null);
      setDone(false);
      try {
        const res = await client.rawRequest(
          "/api/secrets/manager/install",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ backendId, method }),
          },
          { allowNonOk: true },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const { jobId } = (await res.json()) as { jobId: string };

        // EventSource cannot carry the client's Authorization header (browser
        // limitation), but it must at least target the configured apiBase —
        // a bare relative URL would open the stream against the page origin.
        const source = openEventSource(
          resolveApiUrl(`/api/secrets/manager/install/${jobId}`),
        );
        sourceRef.current = source;
        if (!source) {
          throw new Error(
            t("vault.install.streamDisconnected", {
              defaultValue: "install stream disconnected",
            }),
          );
        }
        source.onmessage = (event) => {
          let data:
            | { type: "log"; stream: "stdout" | "stderr"; line: string }
            | { type: "status"; status: string }
            | { type: "done"; exitCode: number }
            | { type: "error"; message: string };
          try {
            data = JSON.parse(event.data);
          } catch {
            // Ignore malformed frames (heartbeats / proxy noise).
            return;
          }
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
        };
        source.onerror = () => {
          if (!sourceRef.current) return;
          source.close();
          sourceRef.current = null;
          if (!done && !error) {
            setError(
              t("vault.install.streamDisconnected", {
                defaultValue: "install stream disconnected",
              }),
            );
            setRunning(false);
          }
        };
      } catch (err) {
        // Boundary translation: fetch / parse failures land here.
        setError(
          err instanceof Error
            ? err.message
            : t("vault.install.failed", { defaultValue: "install failed" }),
        );
        setRunning(false);
      }
    },
    [backendId, done, error, t],
  );

  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;

  return (
    <div className="mt-3 space-y-2 rounded-sm border border-border/50 bg-bg/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-txt">
          {t("vault.install.title", {
            label: backendLabel,
            defaultValue: "Install {{label}}",
          })}
        </p>
        <Button
          ref={closeRef}
          {...closeAgentProps}
          variant="ghost"
          size="sm"
          className="h-6 rounded-sm px-2 text-2xs"
          onClick={close}
          disabled={running}
        >
          {t("vault.install.close", { defaultValue: "Close" })}
        </Button>
      </div>

      {!running && !done && (
        <div className="space-y-1.5">
          {methods.length === 0 ? (
            <p className="text-2xs text-muted">
              {t("vault.install.noInstaller", {
                label: backendLabel,
                defaultValue:
                  "No automated installer is available on this OS for {{label}}. The vendor's CLI may need a manual install.",
              })}
            </p>
          ) : (
            methods.map((m) => (
              <InstallMethodButton
                key={methodKey(m)}
                backendId={backendId}
                method={m}
                onStart={() => void start(m)}
              />
            ))
          )}
        </div>
      )}

      {running && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t("vault.install.installing", { defaultValue: "Installing…" })}
          </div>
          {lastLog && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-sm border border-border/40 bg-card/40 p-2 text-2xs text-muted">
              {lastLog}
            </pre>
          )}
        </div>
      )}

      {done && !error && (
        <div className="flex items-center justify-between gap-2 rounded-sm border border-ok/30 bg-ok/10 px-2 py-1.5 text-xs text-ok">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            {t("vault.install.complete", { defaultValue: "Install complete." })}
          </span>
          <Button
            ref={continueRef}
            {...continueAgentProps}
            variant="ghost"
            size="sm"
            className="h-6 rounded-sm px-2 text-2xs"
            onClick={onComplete}
          >
            {t("vault.install.continue", { defaultValue: "Continue" })}
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
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

function InstallMethodButton({
  backendId,
  method,
  onStart,
}: {
  backendId: InstallableBackendId;
  method: InstallMethod;
  onStart: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `vault-install-method-${backendId}-${methodKey(method)}`,
    role: "button",
    label: describeMethod(method),
    group: "vault-install",
    description: `Install ${backendId} via ${method.kind}`,
    onActivate: onStart,
  });
  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="outline"
      size="sm"
      className="h-8 w-full justify-start gap-2 rounded-sm"
      onClick={onStart}
    >
      {method.kind === "manual" ? (
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Download className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="truncate text-xs">{describeMethod(method)}</span>
    </Button>
  );
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
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [signInAddress, setSignInAddress] = useState("");
  const [masterPassword, setMasterPassword] = useState("");
  const [bwClientId, setBwClientId] = useState("");
  const [bwClientSecret, setBwClientSecret] = useState("");

  const { ref: emailRef, agentProps: emailAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-signin-email-${backendId}`,
      role: "text-input",
      label: `${backendLabel} email`,
      group: "vault-signin",
      getValue: () => email,
      onFill: (v) => setEmail(v),
    });
  const { ref: secretKeyRef, agentProps: secretKeyAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-signin-secret-key-${backendId}`,
      role: "text-input",
      label: `${backendLabel} secret key`,
      group: "vault-signin",
      getValue: () => secretKey,
      onFill: (v) => setSecretKey(v),
    });
  const { ref: addressRef, agentProps: addressAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-signin-address-${backendId}`,
      role: "text-input",
      label: `${backendLabel} sign-in address`,
      group: "vault-signin",
      getValue: () => signInAddress,
      onFill: (v) => setSignInAddress(v),
    });
  const { ref: clientIdRef, agentProps: clientIdAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-signin-client-id-${backendId}`,
      role: "text-input",
      label: `${backendLabel} client id`,
      group: "vault-signin",
      getValue: () => bwClientId,
      onFill: (v) => setBwClientId(v),
    });
  const { ref: clientSecretRef, agentProps: clientSecretAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-signin-client-secret-${backendId}`,
      role: "text-input",
      label: `${backendLabel} client secret`,
      group: "vault-signin",
      getValue: () => bwClientSecret,
      onFill: (v) => setBwClientSecret(v),
    });
  const { ref: masterPasswordRef, agentProps: masterPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `vault-signin-master-password-${backendId}`,
      role: "text-input",
      label: `${backendLabel} master password`,
      group: "vault-signin",
      getValue: () => masterPassword,
      onFill: (v) => setMasterPassword(v),
    });
  const { ref: cancelRef, agentProps: cancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-signin-cancel-${backendId}`,
      role: "button",
      label: `Cancel ${backendLabel} sign-in`,
      group: "vault-signin",
      onActivate: onCancel,
    });
  const { ref: submitRef, agentProps: submitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `vault-signin-submit-${backendId}`,
      role: "button",
      label: `Sign in to ${backendLabel}`,
      group: "vault-signin",
    });

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
      const res = await client.rawRequest(
        "/api/secrets/manager/signin",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        { allowNonOk: true },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      onComplete();
    } catch (err) {
      // Boundary translation: surface vendor sign-in errors to the form.
      setError(
        err instanceof Error
          ? err.message
          : t("vault.signin.failed", { defaultValue: "sign-in failed" }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mt-3 space-y-2 rounded-sm border border-border/50 bg-bg/30 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-txt">
          {t("vault.signin.title", {
            label: backendLabel,
            defaultValue: "Sign in to {{label}}",
          })}
        </p>
        <Button
          ref={cancelRef}
          {...cancelAgentProps}
          variant="ghost"
          size="sm"
          type="button"
          className="h-6 rounded-sm px-2 text-2xs"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("vault.signin.cancel", { defaultValue: "Cancel" })}
        </Button>
      </div>

      {backendId === "1password" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="op-email" className="text-2xs text-muted">
              {t("vault.signin.email", { defaultValue: "Email" })}
            </Label>
            <Input
              ref={emailRef}
              {...emailAgentProps}
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
              {t("vault.signin.secretKey", {
                defaultValue: "Secret key (34 chars)",
              })}
            </Label>
            <Input
              ref={secretKeyRef}
              {...secretKeyAgentProps}
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
              {t("vault.signin.address", {
                defaultValue:
                  "Sign-in address (optional, e.g. my.1password.com)",
              })}
            </Label>
            <Input
              ref={addressRef}
              {...addressAgentProps}
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
            {t("vault.signin.bitwardenHint", {
              defaultValue:
                "Bitwarden requires API key credentials for non-interactive sign-in. Create one at Settings → Security → Keys → API key.",
            })}
          </p>
          <div className="space-y-1">
            <Label htmlFor="bw-client-id" className="text-2xs text-muted">
              {t("vault.signin.clientId", {
                defaultValue: "client_id (BW_CLIENTID)",
              })}
            </Label>
            <Input
              ref={clientIdRef}
              {...clientIdAgentProps}
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
              {t("vault.signin.clientSecret", {
                defaultValue: "client_secret (BW_CLIENTSECRET)",
              })}
            </Label>
            <Input
              ref={clientSecretRef}
              {...clientSecretAgentProps}
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
          {t("vault.signin.protonpassBeta", {
            defaultValue:
              "Proton Pass CLI is in closed beta — automated sign-in is not yet supported.",
          })}
        </p>
      )}

      <div className="space-y-1">
        <Label htmlFor="master-password" className="text-2xs text-muted">
          {t("vault.signin.masterPassword", {
            defaultValue: "Master password",
          })}
        </Label>
        <Input
          ref={masterPasswordRef}
          {...masterPasswordAgentProps}
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
        <div className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          ref={submitRef}
          {...submitAgentProps}
          type="submit"
          variant="default"
          size="sm"
          className="h-7 gap-1 rounded-sm px-3 text-xs"
          disabled={submitting || backendId === "protonpass"}
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t("vault.signin.signingIn", { defaultValue: "Signing in…" })}
            </>
          ) : (
            <>
              <LogIn className="h-3.5 w-3.5" aria-hidden />
              {t("vault.signin.signIn", { defaultValue: "Sign in" })}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
