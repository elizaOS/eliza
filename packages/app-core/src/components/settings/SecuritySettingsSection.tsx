import { Button, cn, Input, Label } from "@elizaos/ui";
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
  "rounded-2xl border border-border/50 bg-bg/40 p-5 shadow-sm space-y-4";
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

async function loadAccessState(): Promise<AccessState> {
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

function AccessModeSection() {
  const [state, setState] = useState<AccessState>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    setState(await loadAccessState());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  let title = "Checking access";
  let detail = "Confirming how this browser is connected.";
  let status = "Checking";

  if (state.phase === "loaded") {
    if (state.access.mode === "local") {
      title = "Local access";
      detail =
        "This browser is on the host machine. Localhost and Electrobun access do not require a password. Remote browsers use the remote password below.";
      status = state.access.passwordConfigured
        ? "Remote password set"
        : "Remote password not set";
    } else {
      title = "Remote session";
      detail =
        "This browser is signed in remotely. Localhost and Electrobun still use local access on the host machine.";
      status = "Signed in";
    }
  } else if (state.phase === "locked") {
    title = "Remote access";
    detail =
      state.reason === "remote_password_not_configured"
        ? "Remote access is disabled until this instance is opened on the host machine and a remote password is set."
        : "Remote access requires a password session.";
    status = state.access?.passwordConfigured ? "Password required" : "Not set";
  } else if (state.phase === "error") {
    title = "Access unavailable";
    detail = state.message;
    status = "Unavailable";
  }

  return (
    <SectionShell
      icon={<Shield className="h-4 w-4 opacity-60" />}
      title="Access mode"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground/90">{title}</div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {detail}
          </p>
        </div>
        <span className="inline-flex w-fit shrink-0 rounded-full border border-border/60 bg-bg/70 px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {state.phase === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {status}
            </span>
          ) : (
            status
          )}
        </span>
      </div>
      {state.phase === "loaded" && (
        <p className="text-xs text-muted-foreground/70">
          Current identity: {state.identity.displayName}
        </p>
      )}
      <button
        type="button"
        onClick={load}
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

function RemotePasswordSection() {
  const displayNameId = useId().replace(/:/g, "");
  const currentPasswordId = useId().replace(/:/g, "");
  const newPasswordId = useId().replace(/:/g, "");
  const confirmPasswordId = useId().replace(/:/g, "");

  const [accessState, setAccessState] = useState<AccessState>({
    phase: "loading",
  });
  const [displayName, setDisplayName] = useState("Owner");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<PasswordState>({ phase: "idle" });

  const load = useCallback(async () => {
    setAccessState({ phase: "loading" });
    setAccessState(await loadAccessState());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

      setState({ phase: "success", message: "Remote password saved." });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await load();
    },
    [
      confirmPassword,
      currentPassword,
      currentPasswordRequired,
      displayName,
      load,
      loaded,
      newPassword,
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

function OwnerBindingsSection() {
  return (
    <SectionShell
      icon={<Shield className="h-4 w-4 opacity-60" />}
      title="Connector owner bindings"
    >
      <p className="text-sm text-muted-foreground">
        No connector bindings configured. Set up a Discord or Telegram connector
        in Settings to enable DM-link login.
      </p>
    </SectionShell>
  );
}

function MachineTokensSection() {
  return (
    <SectionShell
      icon={<KeyRound className="h-4 w-4 opacity-60" />}
      title="Machine tokens"
    >
      <p className="text-sm text-muted-foreground">
        Machine token management is coming in a future release. Existing
        CI/pipeline bearer tokens continue to work during the migration window.
      </p>
    </SectionShell>
  );
}

export function SecuritySettingsSection() {
  return (
    <div className="space-y-4">
      <AccessModeSection />
      <RemotePasswordSection />
      <SessionsSection />
      <OwnerBindingsSection />
      <MachineTokensSection />
    </div>
  );
}
