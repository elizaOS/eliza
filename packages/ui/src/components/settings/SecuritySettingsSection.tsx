import {
  KeyRound,
  Laptop,
  Loader2,
  Monitor,
  RefreshCw,
  Shield,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import {
  type AuthAccessInfo,
  type AuthIdentity,
  type AuthSessionListEntry,
  authChangePassword,
  authListSessions,
  authMe,
  authRevokeSession,
  authSetup,
} from "../../api/auth-client";
import { useBootConfig } from "../../config/boot-config-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

function formatRelativeTime(ms: number | null): string {
  if (ms == null) return "local only";
  const diff = ms - Date.now();
  const absDiff = Math.abs(diff);
  const mins = Math.floor(absDiff / 60_000);
  const hours = Math.floor(absDiff / 3_600_000);
  const days = Math.floor(absDiff / 86_400_000);
  if (days > 0) return diff < 0 ? `${days}d ago` : `in ${days}d`;
  if (hours > 0) return diff < 0 ? `${hours}h ago` : `in ${hours}h`;
  if (mins > 0) return diff < 0 ? `${mins}m ago` : `in ${mins}m`;
  return diff < 0 ? "just now" : "soon";
}

function DeviceIcon({ userAgent }: { userAgent: string | null }) {
  if (!userAgent) return <Monitor className="h-4 w-4 shrink-0 opacity-50" />;
  const ua = userAgent.toLowerCase();
  if (/mobile|android|iphone|ipad/.test(ua)) {
    return <Smartphone className="h-4 w-4 shrink-0 opacity-70" />;
  }
  return <Laptop className="h-4 w-4 shrink-0 opacity-70" />;
}

const SECTION_CLASS =
  "rounded-lg border border-border/50 bg-bg/40 p-4 shadow-sm space-y-4 sm:p-5";
const SECTION_TITLE_CLASS =
  "flex items-center gap-2 text-sm font-semibold text-foreground/90";
const DIVIDER_CLASS = "border-t border-border/40";

function SectionShell({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={SECTION_CLASS}>
      <h3 className={SECTION_TITLE_CLASS}>
        {icon}
        {title}
      </h3>
      <div className={DIVIDER_CLASS} />
      {children}
    </div>
  );
}

type AccessState =
  | { phase: "loading" }
  | {
      phase: "loaded";
      identity: AuthIdentity;
      access: AuthAccessInfo;
    }
  | {
      phase: "locked";
      reason: "remote_auth_required" | "remote_password_not_configured" | null;
      access: AuthAccessInfo | null;
    }
  | { phase: "error"; message: string };

async function fetchAccessState(): Promise<AccessState> {
  const result = await authMe();
  if (result.ok === true) {
    return {
      phase: "loaded",
      identity: result.identity,
      access: result.access,
    };
  }
  if (result.ok === false && result.status === 401) {
    return {
      phase: "locked",
      reason:
        result.reason === "remote_auth_required" ||
        result.reason === "remote_password_not_configured"
          ? result.reason
          : null,
      access: result.access ?? null,
    };
  }
  return {
    phase: "error",
    message: "Security settings are unavailable while auth storage is offline.",
  };
}

function parseAbsoluteUrl(value: string | null | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function isAllInterfacesHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
  );
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    normalized.endsWith(".local")
  );
}

function securitySettingsUrl(origin: string): string {
  return `${trimTrailingSlash(origin)}/settings#security`;
}

function describeEndpoint(url: URL): { value: string; detail: string } {
  if (isAllInterfacesHost(url.hostname)) {
    return {
      value: "All interfaces",
      detail: `${url.host}; use this machine's LAN, tailnet, or tunnel hostname from another device.`,
    };
  }

  if (isLoopbackHost(url.hostname)) {
    return {
      value: "Loopback only",
      detail: `${url.host}; reachable from this machine only.`,
    };
  }

  if (isPrivateHost(url.hostname)) {
    return {
      value: "LAN or tailnet",
      detail: `${url.host}; reachable where this private network permits.`,
    };
  }

  return {
    value: "Remote URL",
    detail: `${url.host}; remote browsers can use this address if firewall rules allow it.`,
  };
}

function currentPageOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const protocol = window.location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return null;
  return window.location.origin;
}

function AccessInfoRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail: string;
}) {
  return (
    <div className="grid gap-1 border-t border-border/30 py-2.5 first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 space-y-0.5">
        <div className="break-words text-sm font-medium text-foreground/90">
          {value}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger";
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium",
        tone === "ok" &&
          "border-[var(--ok-muted)] bg-[var(--ok-subtle)] text-ok",
        tone === "warn" && "border-warning/40 bg-warning/10 text-warning",
        tone === "danger" && "border-danger/40 bg-danger/10 text-danger",
        tone === "neutral" && "border-border/60 bg-bg/70 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function AccessModeSection({
  state,
  onRefresh,
}: {
  state: AccessState;
  onRefresh: () => Promise<void>;
}) {
  const bootConfig = useBootConfig();

  let title = "Checking access";
  let detail = "Confirming how this browser is connected.";
  let status = "Checking";
  let statusTone: "neutral" | "ok" | "warn" | "danger" = "neutral";
  let currentBrowserValue: ReactNode = "Checking";
  let currentBrowserDetail =
    "Waiting for the auth endpoint to identify this browser.";
  let remotePasswordValue = "Checking";
  let remotePasswordDetail =
    "Waiting for the auth endpoint to report remote password state.";
  let remotePasswordTone: "neutral" | "ok" | "warn" | "danger" = "neutral";

  if (state.phase === "loaded") {
    if (state.access.mode === "local") {
      title = "Local access";
      detail =
        "This browser is on the host machine. Localhost and Electrobun access do not require a password. Remote browsers use the remote password below.";
      status = state.access.passwordConfigured
        ? "Remote password set"
        : "Remote password not set";
      statusTone = state.access.passwordConfigured ? "ok" : "warn";
      currentBrowserValue = "Local host";
      currentBrowserDetail =
        "The current browser is trusted because it is running from localhost or the desktop renderer.";
    } else {
      title = "Remote session";
      detail =
        "This browser is signed in remotely. Localhost and Electrobun still use local access on the host machine.";
      status = "Signed in";
      statusTone = "ok";
      currentBrowserValue = "Remote browser";
      currentBrowserDetail =
        "This session is authenticated with the configured remote password.";
    }
    remotePasswordValue = state.access.passwordConfigured ? "Set" : "Not set";
    remotePasswordDetail = state.access.passwordConfigured
      ? "Remote browsers can sign in with the configured password."
      : "Remote browsers cannot sign in until a remote password is set.";
    remotePasswordTone = state.access.passwordConfigured ? "ok" : "warn";
  } else if (state.phase === "locked") {
    title = "Remote access";
    detail =
      state.reason === "remote_password_not_configured"
        ? "Remote access is disabled until this instance is opened on the host machine and a remote password is set."
        : "Remote access requires a password session.";
    status = state.access?.passwordConfigured ? "Password required" : "Not set";
    statusTone = state.access?.passwordConfigured ? "warn" : "danger";
    currentBrowserValue = "Remote browser";
    currentBrowserDetail =
      state.reason === "remote_password_not_configured"
        ? "This browser is remote and no remote password is configured yet."
        : "This browser is remote and needs a password session.";
    remotePasswordValue = state.access?.passwordConfigured ? "Set" : "Not set";
    remotePasswordDetail = state.access?.passwordConfigured
      ? "Remote password exists; sign in to manage sessions and changes."
      : "Remote access is disabled until the host machine sets a password.";
    remotePasswordTone = state.access?.passwordConfigured ? "warn" : "danger";
  } else if (state.phase === "error") {
    title = "Access unavailable";
    detail = state.message;
    status = "Unavailable";
    statusTone = "danger";
    currentBrowserValue = "Unavailable";
    currentBrowserDetail = state.message;
    remotePasswordValue = "Unavailable";
    remotePasswordDetail = "The auth endpoint did not return password state.";
    remotePasswordTone = "danger";
  }

  const pageOrigin = currentPageOrigin();
  const pageUrl = pageOrigin ? securitySettingsUrl(pageOrigin) : null;
  const pageEndpoint = parseAbsoluteUrl(pageOrigin);
  const pageEndpointDescription = pageEndpoint
    ? describeEndpoint(pageEndpoint)
    : null;
  const apiBase =
    bootConfig.apiBase?.trim() ||
    (pageOrigin ? trimTrailingSlash(pageOrigin) : null);
  const apiEndpoint = parseAbsoluteUrl(apiBase);
  const apiEndpointDescription = apiEndpoint
    ? describeEndpoint(apiEndpoint)
    : null;
  const pageUrlLabel =
    pageEndpoint && !isLoopbackHost(pageEndpoint.hostname)
      ? "Remote URL"
      : "Local URL";

  return (
    <SectionShell
      icon={<Shield className="h-4 w-4 opacity-60" />}
      title="Access"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground/90">{title}</div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {detail}
          </p>
        </div>
        <StatusBadge tone={statusTone}>
          {state.phase === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {status}
            </span>
          ) : (
            status
          )}
        </StatusBadge>
      </div>
      <div className="rounded-md border border-border/40 bg-bg/35 px-3">
        <AccessInfoRow
          label="Current browser"
          value={currentBrowserValue}
          detail={currentBrowserDetail}
        />
        <AccessInfoRow
          label="Local access"
          value="Enabled"
          detail="Host-machine localhost and desktop renderer sessions do not require the remote password."
        />
        <AccessInfoRow
          label="Remote password"
          value={
            <StatusBadge tone={remotePasswordTone}>
              {remotePasswordValue}
            </StatusBadge>
          }
          detail={remotePasswordDetail}
        />
        {pageUrl && pageEndpointDescription && (
          <AccessInfoRow
            label={pageUrlLabel}
            value={pageUrl}
            detail={pageEndpointDescription.detail}
          />
        )}
        {apiBase && apiEndpointDescription && (
          <AccessInfoRow
            label="API base"
            value={trimTrailingSlash(apiBase)}
            detail={`${apiEndpointDescription.value}: ${apiEndpointDescription.detail}`}
          />
        )}
        {state.phase === "loaded" && (
          <AccessInfoRow
            label="Identity"
            value={state.identity.displayName}
            detail={`Signed in as ${state.identity.kind}.`}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => void onRefresh()}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <RefreshCw className="h-3 w-3" />
        Refresh
      </button>
    </SectionShell>
  );
}

type SessionsState =
  | { phase: "loading" }
  | { phase: "loaded"; sessions: AuthSessionListEntry[] }
  | { phase: "error"; message: string };

function SessionsSection() {
  const [state, setState] = useState<SessionsState>({ phase: "loading" });
  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await authListSessions();
    if (result.ok === true) {
      setState({ phase: "loaded", sessions: result.sessions });
    } else if (result.ok === false) {
      setState({
        phase: "error",
        message:
          result.status === 401
            ? "You must be signed in to view sessions."
            : "Could not load sessions. Try reloading the page.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = useCallback(
    async (sessionId: string) => {
      setRevokingIds((prev) => new Set([...prev, sessionId]));
      const result = await authRevokeSession(sessionId);
      setRevokingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      if (result.ok) void load();
    },
    [load],
  );

  const handleRevokeOthers = useCallback(async () => {
    if (state.phase !== "loaded") return;
    const others = state.sessions.filter((s) => !s.current);
    for (const s of others) {
      await handleRevoke(s.id);
    }
  }, [state, handleRevoke]);

  return (
    <SectionShell
      icon={<Shield className="h-4 w-4 opacity-60" />}
      title="Active sessions"
    >
      {state.phase === "loading" && (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sessions...
        </div>
      )}

      {state.phase === "error" && (
        <p className="py-2 text-sm text-danger">{state.message}</p>
      )}

      {state.phase === "loaded" && (
        <div className="space-y-3">
          {state.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active sessions.</p>
          ) : (
            <div className="divide-y divide-border/30">
              {state.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  revoking={revokingIds.has(session.id)}
                  onRevoke={handleRevoke}
                />
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>

            {state.sessions.filter((s) => !s.current).length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRevokeOthers}
                className="border-danger/40 text-xs text-danger hover:bg-danger/10"
              >
                Sign out everywhere else
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}

function SessionRow({
  session,
  revoking,
  onRevoke,
}: {
  session: AuthSessionListEntry;
  revoking: boolean;
  onRevoke: (id: string) => void;
}) {
  return (
    <div className="flex items-start gap-3 py-3">
      <DeviceIcon userAgent={session.userAgent} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize text-foreground/90">
            {session.kind}
          </span>
          {session.current && (
            <span className="rounded-full border border-[var(--ok-muted)] bg-[var(--ok-subtle)] px-2 py-0.5 text-3xs font-medium uppercase tracking-[0.08em] text-ok">
              This session
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground/80">
          {session.ip ?? "Unknown IP"} &middot;{" "}
          {session.userAgent
            ? session.userAgent.slice(0, 60)
            : "Unknown client"}
        </p>
        <p className="text-xs text-muted-foreground/60">
          Last seen {formatRelativeTime(session.lastSeenAt)} &middot; expires{" "}
          {formatRelativeTime(session.expiresAt)}
        </p>
      </div>

      {!session.current && (
        <Button
          variant="ghost"
          size="sm"
          disabled={revoking}
          onClick={() => onRevoke(session.id)}
          className="shrink-0 text-xs text-danger hover:bg-danger/10 hover:text-danger"
          aria-label="Revoke this session"
        >
          {revoking ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      )}
    </div>
  );
}

type PasswordState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "success"; message: string }
  | { phase: "error"; message: string };

function RemotePasswordSection({
  accessState,
  onAccessChanged,
}: {
  accessState: AccessState;
  onAccessChanged: () => Promise<void>;
}) {
  const displayNameId = useId().replace(/:/g, "");
  const currentPasswordId = useId().replace(/:/g, "");
  const newPasswordId = useId().replace(/:/g, "");
  const confirmPasswordId = useId().replace(/:/g, "");

  const [displayName, setDisplayName] = useState("Owner");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<PasswordState>({ phase: "idle" });

  const loaded = accessState.phase === "loaded" ? accessState : null;
  const setupMode =
    loaded?.access.mode === "local" && !loaded.access.ownerConfigured;
  const localAccess = loaded?.access.mode === "local";
  const currentPasswordRequired = Boolean(loaded && !localAccess);
  const confirmMismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;
  const isSubmitting = state.phase === "submitting";
  const canSubmit =
    Boolean(loaded) &&
    (!setupMode || displayName.trim().length > 0) &&
    (!currentPasswordRequired || currentPassword.length > 0) &&
    newPassword.length >= 12 &&
    newPassword === confirmPassword &&
    !isSubmitting;

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!loaded) return;
      if (newPassword !== confirmPassword) {
        setState({ phase: "error", message: "New passwords do not match." });
        return;
      }

      setState({ phase: "submitting" });
      const result = setupMode
        ? await authSetup({
            displayName: displayName.trim(),
            password: newPassword,
          })
        : await authChangePassword({
            currentPassword: currentPasswordRequired
              ? currentPassword
              : undefined,
            newPassword,
          });

      if (result.ok === false) {
        setState({ phase: "error", message: result.message });
        return;
      }

      setState({
        phase: "success",
        message:
          "Remote access is enabled. Remote browsers can sign in with this password when they can reach this instance.",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await onAccessChanged();
    },
    [
      confirmPassword,
      currentPassword,
      currentPasswordRequired,
      displayName,
      loaded,
      newPassword,
      onAccessChanged,
      setupMode,
    ],
  );

  if (accessState.phase === "loading") {
    return (
      <SectionShell
        icon={<KeyRound className="h-4 w-4 opacity-60" />}
        title="Remote password"
      >
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading password settings...
        </div>
      </SectionShell>
    );
  }

  if (accessState.phase !== "loaded") {
    const message =
      accessState.phase === "locked" &&
      accessState.reason === "remote_password_not_configured"
        ? "Remote access is not enabled yet. Open this instance on the host machine via localhost and set a remote password here."
        : "Sign in to manage the remote password.";
    return (
      <SectionShell
        icon={<KeyRound className="h-4 w-4 opacity-60" />}
        title="Remote password"
      >
        <p className="text-sm text-muted-foreground">{message}</p>
      </SectionShell>
    );
  }

  const description = localAccess
    ? "Set the password used by browsers that connect to this instance from another machine. Localhost and Electrobun do not use it."
    : "Change the password for this remote browser session.";
  const buttonLabel =
    setupMode || !accessState.access.passwordConfigured
      ? "Set remote password"
      : "Change remote password";

  return (
    <SectionShell
      icon={<KeyRound className="h-4 w-4 opacity-60" />}
      title="Remote password"
    >
      <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
        {setupMode && (
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={displayNameId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Display name
            </Label>
            <Input
              id={displayNameId}
              type="text"
              autoComplete="username"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                if (state.phase === "error") setState({ phase: "idle" });
              }}
              disabled={isSubmitting}
            />
          </div>
        )}

        {currentPasswordRequired && (
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={currentPasswordId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Current password
            </Label>
            <Input
              id={currentPasswordId}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                if (state.phase === "error") setState({ phase: "idle" });
              }}
              disabled={isSubmitting}
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={newPasswordId}
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            New password
          </Label>
          <Input
            id={newPasswordId}
            type="password"
            autoComplete="new-password"
            placeholder="At least 12 characters"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
              if (state.phase === "error") setState({ phase: "idle" });
            }}
            disabled={isSubmitting}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={confirmPasswordId}
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            Confirm new password
          </Label>
          <Input
            id={confirmPasswordId}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              if (state.phase === "error") setState({ phase: "idle" });
            }}
            disabled={isSubmitting}
            aria-invalid={confirmMismatch}
            className={cn(
              confirmMismatch && "border-danger focus-visible:border-danger",
            )}
          />
          {confirmMismatch && (
            <p className="text-xs text-danger">Passwords do not match.</p>
          )}
        </div>

        {state.phase === "error" && (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        )}

        {state.phase === "success" && (
          <p className="text-sm text-ok">{state.message}</p>
        )}

        <div className="flex justify-end pt-1">
          <Button type="submit" disabled={!canSubmit} size="sm">
            {isSubmitting ? "Saving..." : buttonLabel}
          </Button>
        </div>
      </form>
    </SectionShell>
  );
}

export function SecuritySettingsSection() {
  const [accessState, setAccessState] = useState<AccessState>({
    phase: "loading",
  });

  const refreshAccessState = useCallback(async () => {
    setAccessState({ phase: "loading" });
    setAccessState(await fetchAccessState());
  }, []);

  useEffect(() => {
    void refreshAccessState();
  }, [refreshAccessState]);

  return (
    <div className="space-y-4">
      <AccessModeSection state={accessState} onRefresh={refreshAccessState} />
      <RemotePasswordSection
        accessState={accessState}
        onAccessChanged={refreshAccessState}
      />
      <SessionsSection />
    </div>
  );
}
