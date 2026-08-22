/** Accessible Devices & Runtimes settings surface for local, Cloud, relay, and SSH targets. */
import encodeQR from "@paulmillr/qr";
import {
  Check,
  CircleAlert,
  Cloud,
  HardDrive,
  KeyRound,
  Link2,
  LoaderCircle,
  MonitorSmartphone,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import type { SshHostInspection } from "../../platform/ssh-runtime";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsGroup, SettingsStack } from "./settings-layout";

export type RuntimeTargetStatus = "connected" | "offline" | "error" | "pairing";

export interface DeviceRuntimeTarget {
  id: string;
  label: string;
  detail: string;
  kind: "local" | "cloud" | "relay" | "ssh" | "vps";
  status: RuntimeTargetStatus;
  selected: boolean;
  activity: string;
  error?: string;
  canPair?: boolean;
  canRevoke?: boolean;
  canRemove?: boolean;
}

export interface DevicePairingView {
  hostId: string;
  hostLabel: string;
  sessionId: string;
  code: string;
  expiresAt: string;
  qrPayload: string;
}

export interface SshConnectInput {
  label: string;
  target: string;
  sshPort: number;
  remoteApiPort: number;
  identityFile?: string;
  accessToken?: string;
  expectedFingerprint: string;
}

export interface LinuxRemoteTargetView {
  hostId: string | null;
  enrolled: boolean;
  running: boolean;
  activeSessions: number;
  lastErrorCode: string | null;
}

export interface DevicesRuntimesSectionProps {
  targets: DeviceRuntimeTarget[];
  pairing?: DevicePairingView | null;
  sshInspection?: SshHostInspection | null;
  linuxTarget?: LinuxRemoteTargetView | null;
  busy?: boolean;
  error?: string | null;
  cloudState?: "loading" | "available" | "signed-out" | "error";
  onRefresh: () => void | Promise<void>;
  onSelect: (id: string) => void | Promise<void>;
  onRetry: (id: string) => void | Promise<void>;
  onPair: (id: string) => void | Promise<void>;
  onRevoke: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  onInspectSsh: (input: {
    target: string;
    sshPort: number;
  }) => void | Promise<void>;
  onConnectSsh: (input: SshConnectInput) => void | Promise<void>;
  onEnrollLinuxTarget?: () => void | Promise<void>;
  onActivateLinuxTarget?: (input: {
    sessionId: string;
    code: string;
  }) => void | Promise<void>;
  onSetLinuxTargetRunning?: (running: boolean) => void | Promise<void>;
  onRevokeLinuxTarget?: () => void | Promise<void>;
  className?: string;
}

function LinuxTargetPanel({
  target,
  pairing,
  busy,
  onEnroll,
  onActivate,
  onSetRunning,
  onRevoke,
}: {
  target: LinuxRemoteTargetView;
  pairing?: DevicePairingView | null;
  busy: boolean;
  onEnroll?: () => void | Promise<void>;
  onActivate?: (input: {
    sessionId: string;
    code: string;
  }) => void | Promise<void>;
  onSetRunning?: (running: boolean) => void | Promise<void>;
  onRevoke?: () => void | Promise<void>;
}) {
  const [sessionId, setSessionId] = useState("");
  const [code, setCode] = useState("");
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const localPairing = pairing?.hostId === target.hostId ? pairing : null;
  return (
    <SettingsGroup
      title="Share this Linux runtime"
      description="Enroll this computer as an encrypted remote target, then approve a one-use pairing code shown on your controller device."
      footer="The host token and target private keys stay in the native OS credential store."
      bare
    >
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-txt-strong">
              This Linux computer
            </p>
            <p className="mt-1 text-xs text-muted">
              {target.enrolled
                ? `${target.running ? "Relay running" : "Relay stopped"} · ${target.activeSessions} active session${target.activeSessions === 1 ? "" : "s"}`
                : "Not enrolled with Eliza Cloud"}
            </p>
          </div>
          {!target.enrolled ? (
            <Button
              type="button"
              className="min-h-11"
              disabled={busy || !onEnroll}
              onClick={() => void onEnroll?.()}
            >
              Enroll this computer
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy || !onSetRunning}
                onClick={() => void onSetRunning?.(!target.running)}
              >
                {target.running ? "Stop relay" : "Start relay"}
              </Button>
              {!confirmingRevoke ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 text-destructive"
                  disabled={busy || !onRevoke}
                  onClick={() => setConfirmingRevoke(true)}
                >
                  Revoke host
                </Button>
              ) : null}
            </div>
          )}
        </div>
        {confirmingRevoke ? (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2"
          >
            <span className="mr-auto text-xs text-txt-strong">
              Revoke this host in Cloud, stop its relay, and remove local host
              credentials?
            </span>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => setConfirmingRevoke(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={busy || !onRevoke}
              onClick={() => {
                setConfirmingRevoke(false);
                void onRevoke?.();
              }}
            >
              Confirm revoke
            </Button>
          </div>
        ) : null}
        {target.lastErrorCode ? (
          <p role="alert" className="mt-3 text-xs text-destructive">
            Remote target needs attention ({target.lastErrorCode}). Retry or
            inspect desktop logs.
          </p>
        ) : null}
        {target.enrolled && onActivate ? (
          <div className="mt-4 grid gap-4 border-t border-border pt-4">
            {localPairing ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
                <div>
                  <p className="text-sm font-medium text-txt-strong">
                    Pair {localPairing.hostLabel} on this computer
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Uses this in-memory session and its one-use code.
                  </p>
                </div>
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() =>
                    void onActivate({
                      sessionId: localPairing.sessionId,
                      code: localPairing.code,
                    })
                  }
                >
                  Approve this pairing on this Linux computer
                </Button>
              </div>
            ) : null}
            <p className="text-xs leading-relaxed text-muted">
              Manual cross-device pairing requires both the session ID and the
              6-digit code. Code-only session discovery is not available.
            </p>
            <form
              className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  await onActivate({ sessionId: sessionId.trim(), code });
                  setCode("");
                })();
              }}
            >
              <label
                htmlFor="linux-target-session"
                className="grid gap-1.5 text-xs text-muted"
              >
                Pairing session ID
                <Input
                  id="linux-target-session"
                  required
                  density="relaxed"
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label
                htmlFor="linux-target-code"
                className="grid gap-1.5 text-xs text-muted"
              >
                6-digit code
                <Input
                  id="linux-target-code"
                  required
                  density="relaxed"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  autoComplete="one-time-code"
                />
              </label>
              <Button
                type="submit"
                className="min-h-11"
                disabled={busy || !sessionId.trim() || code.length !== 6}
              >
                Approve pairing
              </Button>
            </form>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

const KIND_ICON = {
  local: HardDrive,
  cloud: Cloud,
  relay: MonitorSmartphone,
  ssh: KeyRound,
  vps: Server,
} as const;

const STATUS_META: Record<
  RuntimeTargetStatus,
  { label: string; className: string }
> = {
  connected: { label: "Connected", className: "text-ok" },
  offline: { label: "Offline", className: "text-muted" },
  error: { label: "Needs attention", className: "text-destructive" },
  pairing: { label: "Pairing", className: "text-accent" },
};

function PairingQr({ payload }: { payload: string }) {
  const matrix = useMemo(
    () => encodeQR(payload, "raw", { ecc: "medium", border: 2 }),
    [payload],
  );
  const dark = matrix.flatMap((row, y) =>
    row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : [])),
  );
  return (
    <svg
      viewBox={`0 0 ${matrix.length} ${matrix.length}`}
      role="img"
      aria-label="QR code for this one-use pairing session"
      className="h-40 w-40 rounded-lg bg-white p-2 text-black"
      shapeRendering="crispEdges"
    >
      <path d={dark.join("")} fill="currentColor" />
    </svg>
  );
}

function PairingPanel({ pairing }: { pairing: DevicePairingView }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(
      0,
      Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1_000),
    ),
  );
  useEffect(() => {
    const update = () =>
      setRemaining(
        Math.max(
          0,
          Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1_000),
        ),
      );
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [pairing.expiresAt]);

  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");
  return (
    <div className="grid gap-5 rounded-xl border border-accent/35 bg-accent/5 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-txt-strong">
          <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
          Pair {pairing.hostLabel}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Scan the QR code, or enter the session ID and code together on the
          target. The code is valid once for five minutes and cannot be reused.
        </p>
        <output
          className="mt-4 font-[var(--mono)] text-3xl font-semibold tracking-[0.28em] text-txt-strong"
          aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}
          data-testid="pairing-code"
        >
          {pairing.code}
        </output>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="max-w-full break-all rounded bg-surface px-2 py-1 text-xs text-txt-strong">
            Session {pairing.sessionId}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={() =>
              void navigator.clipboard.writeText(pairing.sessionId)
            }
          >
            Copy session ID
          </Button>
        </div>
        <p
          className={cn(
            "mt-2 text-xs",
            remaining ? "text-muted" : "text-destructive",
          )}
        >
          {remaining
            ? `Expires in ${minutes}:${seconds}`
            : "Code expired. Request a new code."}
        </p>
      </div>
      <PairingQr payload={pairing.qrPayload} />
    </div>
  );
}

function RuntimeCard({
  target,
  busy,
  onSelect,
  onRetry,
  onPair,
  onRevoke,
  onRemove,
}: {
  target: DeviceRuntimeTarget;
  busy: boolean;
  onSelect: () => void;
  onRetry: () => void;
  onPair: () => void;
  onRevoke: () => void;
  onRemove: () => void;
}) {
  const Icon = KIND_ICON[target.kind];
  const status = STATUS_META[target.status];
  const [confirming, setConfirming] = useState<"revoke" | "remove" | null>(
    null,
  );
  return (
    <article
      className={cn(
        "relative rounded-xl border bg-card p-4",
        target.selected ? "border-accent/50" : "border-border",
      )}
      aria-label={`${target.label}, ${status.label}${target.selected ? ", selected" : ""}`}
      data-testid={`runtime-target-${target.id}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 rounded-lg border border-border bg-surface p-2">
          <Icon className="h-4 w-4 text-muted" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-semibold text-txt-strong">
              {target.label}
            </h4>
            {target.selected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                <Check className="h-3 w-3" aria-hidden /> Selected
              </span>
            ) : null}
          </div>
          <p className="mt-1 break-words text-xs leading-relaxed text-muted">
            {target.detail}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className={cn("font-medium", status.className)}>
              {status.label}
            </span>
            <span aria-hidden className="text-border">
              •
            </span>
            <span className="text-muted">{target.activity}</span>
          </div>
          {target.error ? (
            <p
              className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
              role="alert"
            >
              <CircleAlert
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              {target.error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {!target.selected && target.status === "connected" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onSelect}
          >
            Use runtime
          </Button>
        ) : null}
        {target.canPair ? (
          <Button
            type="button"
            size="sm"
            className="min-h-11"
            disabled={busy}
            onClick={onPair}
          >
            <Link2 className="mr-1.5 h-4 w-4" aria-hidden /> Pair device
          </Button>
        ) : null}
        {target.status === "offline" || target.status === "error" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onRetry}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Retry
          </Button>
        ) : null}
        {target.canRevoke && !confirming ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={() => setConfirming("revoke")}
          >
            <Unplug className="mr-1.5 h-4 w-4" aria-hidden /> Revoke
          </Button>
        ) : null}
        {target.canRemove && !confirming ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11 text-destructive"
            disabled={busy}
            onClick={() => setConfirming("remove")}
          >
            <Trash2 className="mr-1.5 h-4 w-4" aria-hidden /> Remove
          </Button>
        ) : null}
        {confirming ? (
          <div
            className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2"
            role="alert"
          >
            <span className="mr-auto text-xs text-txt-strong">
              {confirming === "revoke"
                ? "Revoke this encrypted session on every device?"
                : "Remove this runtime and its local credentials?"}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="min-h-11"
              disabled={busy}
              onClick={() => {
                const action = confirming === "revoke" ? onRevoke : onRemove;
                setConfirming(null);
                action();
              }}
            >
              Confirm {confirming}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AdvancedSsh({
  busy,
  inspection,
  onInspect,
  onConnect,
}: {
  busy: boolean;
  inspection?: SshHostInspection | null;
  onInspect: DevicesRuntimesSectionProps["onInspectSsh"];
  onConnect: DevicesRuntimesSectionProps["onConnectSsh"];
}) {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [remoteApiPort, setRemoteApiPort] = useState("3000");
  const [identityFile, setIdentityFile] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const inspectedTarget =
    inspection?.target === target.trim() &&
    inspection.sshPort === Number(sshPort);
  const valid =
    label.trim() &&
    target.trim() &&
    Number(sshPort) > 0 &&
    Number(remoteApiPort) > 0;

  return (
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-semibold text-txt-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Advanced SSH
      </summary>
      <p className="mb-4 text-xs leading-relaxed text-muted">
        Eliza verifies the server SHA256 host fingerprint before connecting.
        Private keys remain in your SSH agent or at their original local path;
        they are never copied to Eliza Cloud.
      </p>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!inspection || !inspectedTarget) {
            void onInspect({ target: target.trim(), sshPort: Number(sshPort) });
            return;
          }
          void (async () => {
            await onConnect({
              label: label.trim(),
              target: target.trim(),
              sshPort: Number(sshPort),
              remoteApiPort: Number(remoteApiPort),
              identityFile: identityFile.trim() || undefined,
              accessToken: accessToken.trim() || undefined,
              expectedFingerprint: inspection.preferredFingerprint,
            });
            setAccessToken("");
          })();
        }}
      >
        <label
          htmlFor="ssh-runtime-label"
          className="grid gap-1.5 text-xs text-muted"
        >
          Name
          <Input
            required
            id="ssh-runtime-label"
            density="relaxed"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Production VPS"
            autoComplete="off"
          />
        </label>
        <label
          htmlFor="ssh-runtime-target"
          className="grid gap-1.5 text-xs text-muted"
        >
          SSH target
          <Input
            required
            id="ssh-runtime-target"
            density="relaxed"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="user@host.example"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label
          htmlFor="ssh-runtime-port"
          className="grid gap-1.5 text-xs text-muted"
        >
          SSH port
          <Input
            required
            id="ssh-runtime-port"
            density="relaxed"
            type="number"
            min={1}
            max={65535}
            value={sshPort}
            onChange={(e) => setSshPort(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="ssh-runtime-api-port"
          className="grid gap-1.5 text-xs text-muted"
        >
          Remote Eliza port
          <Input
            required
            id="ssh-runtime-api-port"
            density="relaxed"
            type="number"
            min={1}
            max={65535}
            value={remoteApiPort}
            onChange={(e) => setRemoteApiPort(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label
          htmlFor="ssh-runtime-identity"
          className="grid gap-1.5 text-xs text-muted"
        >
          Private key path (optional)
          <Input
            id="ssh-runtime-identity"
            density="relaxed"
            value={identityFile}
            onChange={(e) => setIdentityFile(e.target.value)}
            placeholder="/home/me/.ssh/id_ed25519"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label
          htmlFor="ssh-runtime-token"
          className="grid gap-1.5 text-xs text-muted"
        >
          Runtime access token (optional)
          <Input
            id="ssh-runtime-token"
            density="relaxed"
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {inspection && inspectedTarget ? (
          <div
            className={cn(
              "sm:col-span-2 rounded-lg border p-3",
              inspection.changed
                ? "border-destructive/50 bg-destructive/5"
                : "border-accent/35 bg-accent/5",
            )}
            role="status"
          >
            <p className="flex items-center gap-2 text-xs font-semibold text-txt-strong">
              {inspection.changed ? (
                <CircleAlert className="h-4 w-4 text-destructive" aria-hidden />
              ) : (
                <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              )}
              {inspection.changed
                ? "Host key changed — connection blocked"
                : "Verify this host fingerprint"}
            </p>
            <code className="mt-2 block break-all text-xs text-txt-strong">
              {inspection.preferredFingerprint}
            </code>
            {inspection.changed ? (
              <p className="mt-2 text-xs text-destructive">
                The saved key does not match this server. Confirm the change
                outside Eliza before replacing trust.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            className="min-h-11"
            disabled={busy || !valid || Boolean(inspection?.changed)}
          >
            {busy ? (
              <LoaderCircle
                className="mr-1.5 h-4 w-4 motion-safe:animate-spin"
                aria-hidden
              />
            ) : (
              <ShieldCheck className="mr-1.5 h-4 w-4" aria-hidden />
            )}
            {inspection && inspectedTarget
              ? "I verified this fingerprint — connect"
              : "Inspect fingerprint"}
          </Button>
          <span className="text-xs text-muted">
            No password or private key is sent to Cloud.
          </span>
        </div>
      </form>
    </details>
  );
}

export function DevicesRuntimesSection({
  targets,
  pairing,
  sshInspection,
  linuxTarget,
  busy = false,
  error,
  cloudState = "loading",
  onRefresh,
  onSelect,
  onRetry,
  onPair,
  onRevoke,
  onRemove,
  onInspectSsh,
  onConnectSsh,
  onEnrollLinuxTarget,
  onActivateLinuxTarget,
  onSetLinuxTargetRunning,
  onRevokeLinuxTarget,
  className,
}: DevicesRuntimesSectionProps) {
  const { t } = useTranslation();
  return (
    <SettingsStack className={className} data-testid="devices-runtimes">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      {cloudState === "signed-out" ? (
        <div
          role="status"
          className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          {t("settings.devicesRuntimes.cloudSignedOut", {
            defaultValue:
              "Sign in to Eliza Cloud to pair devices. Local and verified SSH runtimes remain available.",
          })}
        </div>
      ) : null}
      {cloudState === "loading" ? (
        <div role="status" className="text-sm text-muted-foreground">
          {t("settings.devicesRuntimes.cloudLoading", {
            defaultValue: "Loading paired devices…",
          })}
        </div>
      ) : null}
      {pairing ? <PairingPanel pairing={pairing} /> : null}
      <SettingsGroup
        title="Devices & Runtimes"
        description="Choose where Eliza runs and securely connect another computer or server."
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            disabled={busy}
            onClick={() => void onRefresh()}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        }
        bare
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-busy={busy}>
          {cloudState !== "loading" && targets.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {t("settings.devicesRuntimes.empty", {
                defaultValue: "No runtimes are configured yet.",
              })}
            </div>
          ) : null}
          {targets.map((target) => (
            <RuntimeCard
              key={target.id}
              target={target}
              busy={busy}
              onSelect={() => void onSelect(target.id)}
              onRetry={() => void onRetry(target.id)}
              onPair={() => void onPair(target.id)}
              onRevoke={() => void onRevoke(target.id)}
              onRemove={() => void onRemove(target.id)}
            />
          ))}
        </div>
      </SettingsGroup>
      {linuxTarget ? (
        <LinuxTargetPanel
          target={linuxTarget}
          pairing={pairing}
          busy={busy}
          onEnroll={onEnrollLinuxTarget}
          onActivate={onActivateLinuxTarget}
          onSetRunning={onSetLinuxTargetRunning}
          onRevoke={onRevokeLinuxTarget}
        />
      ) : null}
      <AdvancedSsh
        busy={busy}
        inspection={sshInspection}
        onInspect={onInspectSsh}
        onConnect={onConnectSsh}
      />
    </SettingsStack>
  );
}
