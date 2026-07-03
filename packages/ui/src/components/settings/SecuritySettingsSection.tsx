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
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
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
import { useBootConfig } from "../../config/boot-config-react.hooks";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import { SettingsGroup, SettingsStack } from "./settings-layout";

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
    <SettingsGroup
      bare
      title={
        <span className="flex items-center gap-2 normal-case tracking-normal text-sm text-txt-strong">
          {icon}
          {title}
        </span>
      }
    >
      <div className="space-y-4">{children}</div>
    </SettingsGroup>
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
    <div className="grid gap-1 py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="min-w-0 space-y-0.5">
        <div className="break-words text-sm font-medium text-txt-strong">
          {value}
        </div>
        <p className="text-xs leading-5 text-muted">{detail}</p>
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
        tone === "ok" && "border-ok/35 bg-ok/12 text-ok",
        tone === "warn" && "border-warn/40 bg-warn/14 text-warn",
        tone === "danger" && "border-danger/40 bg-danger/10 text-danger",
        tone === "neutral" && "border-border/60 bg-bg/70 text-muted",
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
  const { t } = useTranslation();
  const advancedEnabled = useAdvancedSettingsEnabled();
  const { ref: accessRefreshRef, agentProps: accessRefreshAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "security-access-refresh",
      role: "button",
      label: "Refresh access status",
      group: "security-access",
      description: "Re-check how this browser is connected",
      onActivate: () => void onRefresh(),
    });

  let title = t("security.access.checking.title", {
    defaultValue: "Checking access",
  });
  let detail = t("security.access.checking.detail", {
    defaultValue: "Confirming how this browser is connected.",
  });
  let status = t("security.access.status.checking", {
    defaultValue: "Checking",
  });
  let statusTone: "neutral" | "ok" | "warn" | "danger" = "neutral";
  let currentBrowserValue: ReactNode = t("security.access.status.checking", {
    defaultValue: "Checking",
  });
  let currentBrowserDetail = t("security.access.currentBrowser.checking", {
    defaultValue: "Waiting for the auth endpoint to identify this browser.",
  });
  let remotePasswordValue = t("security.access.status.checking", {
    defaultValue: "Checking",
  });
  let remotePasswordDetail = t("security.access.remotePassword.checking", {
    defaultValue:
      "Waiting for the auth endpoint to report remote password state.",
  });
  let remotePasswordTone: "neutral" | "ok" | "warn" | "danger" = "neutral";

  if (state.phase === "loaded") {
    if (state.access.mode === "local") {
      title = t("security.access.local.title", {
        defaultValue: "Local access",
      });
      detail = t("security.access.local.detail", {
        defaultValue:
          "This browser is on the host machine. Remote browsers use the remote password below.",
      });
      status = state.access.passwordConfigured
        ? t("security.access.status.remotePasswordSet", {
            defaultValue: "Remote password set",
          })
        : t("security.access.status.remotePasswordNotSet", {
            defaultValue: "Remote password not set",
          });
      statusTone = state.access.passwordConfigured ? "ok" : "warn";
      currentBrowserValue = t("security.access.currentBrowser.localHost", {
        defaultValue: "Local host",
      });
      currentBrowserDetail = t("security.access.currentBrowser.localDetail", {
        defaultValue:
          "Trusted: running from localhost or the desktop renderer.",
      });
    } else {
      title = t("security.access.remote.title", {
        defaultValue: "Remote session",
      });
      detail = t("security.access.remote.detail", {
        defaultValue:
          "This browser is signed in remotely. Localhost and Electrobun still use local access on the host machine.",
      });
      status = t("security.access.status.signedIn", {
        defaultValue: "Signed in",
      });
      statusTone = "ok";
      currentBrowserValue = t("security.access.currentBrowser.remoteBrowser", {
        defaultValue: "Remote browser",
      });
      currentBrowserDetail = t("security.access.currentBrowser.remoteDetail", {
        defaultValue:
          "This session is authenticated with the configured remote password.",
      });
    }
    remotePasswordValue = state.access.passwordConfigured
      ? t("security.access.value.set", { defaultValue: "Set" })
      : t("security.access.value.notSet", { defaultValue: "Not set" });
    remotePasswordDetail = state.access.passwordConfigured
      ? t("security.access.remotePassword.canSignIn", {
          defaultValue:
            "Remote browsers can sign in with the configured password.",
        })
      : t("security.access.remotePassword.cannotSignIn", {
          defaultValue:
            "Remote browsers cannot sign in until a remote password is set.",
        });
    remotePasswordTone = state.access.passwordConfigured ? "ok" : "warn";
  } else if (state.phase === "locked") {
    title = t("security.access.lockedRemote.title", {
      defaultValue: "Remote access",
    });
    detail =
      state.reason === "remote_password_not_configured"
        ? t("security.access.lockedRemote.detailNotConfigured", {
            defaultValue:
              "Remote access is disabled until this instance is opened on the host machine and a remote password is set.",
          })
        : t("security.access.lockedRemote.detailRequiresPassword", {
            defaultValue: "Remote access requires a password session.",
          });
    status = state.access?.passwordConfigured
      ? t("security.access.status.passwordRequired", {
          defaultValue: "Password required",
        })
      : t("security.access.value.notSet", { defaultValue: "Not set" });
    statusTone = state.access?.passwordConfigured ? "warn" : "danger";
    currentBrowserValue = t("security.access.currentBrowser.remoteBrowser", {
      defaultValue: "Remote browser",
    });
    currentBrowserDetail =
      state.reason === "remote_password_not_configured"
        ? t("security.access.currentBrowser.lockedNotConfigured", {
            defaultValue:
              "This browser is remote and no remote password is configured yet.",
          })
        : t("security.access.currentBrowser.lockedNeedsPassword", {
            defaultValue:
              "This browser is remote and needs a password session.",
          });
    remotePasswordValue = state.access?.passwordConfigured
      ? t("security.access.value.set", { defaultValue: "Set" })
      : t("security.access.value.notSet", { defaultValue: "Not set" });
    remotePasswordDetail = state.access?.passwordConfigured
      ? t("security.access.remotePassword.existsSignIn", {
          defaultValue:
            "Remote password exists; sign in to manage sessions and changes.",
        })
      : t("security.access.remotePassword.disabledUntilSet", {
          defaultValue:
            "Remote access is disabled until the host machine sets a password.",
        });
    remotePasswordTone = state.access?.passwordConfigured ? "warn" : "danger";
  } else if (state.phase === "error") {
    title = t("security.access.error.title", {
      defaultValue: "Access unavailable",
    });
    detail = state.message;
    status = t("security.access.status.unavailable", {
      defaultValue: "Unavailable",
    });
    statusTone = "danger";
    currentBrowserValue = t("security.access.status.unavailable", {
      defaultValue: "Unavailable",
    });
    currentBrowserDetail = state.message;
    remotePasswordValue = t("security.access.status.unavailable", {
      defaultValue: "Unavailable",
    });
    remotePasswordDetail = t("security.access.remotePassword.unavailable", {
      defaultValue: "The auth endpoint did not return password state.",
    });
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
      ? t("security.access.pageUrl.remote", { defaultValue: "Remote URL" })
      : t("security.access.pageUrl.local", { defaultValue: "Local URL" });

  return (
    <SectionShell
      icon={<Shield className="h-4 w-4 opacity-60" />}
      title={t("security.access.sectionTitle", { defaultValue: "Access" })}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-txt-strong">{title}</div>
          <p className="max-w-2xl text-sm leading-6 text-muted">{detail}</p>
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
      <div className="flex flex-col">
        <AccessInfoRow
          label={t("security.access.row.remotePassword", {
            defaultValue: "Remote password",
          })}
          value={
            <StatusBadge tone={remotePasswordTone}>
              {remotePasswordValue}
            </StatusBadge>
          }
          detail={remotePasswordDetail}
        />
        {state.phase === "loaded" && (
          <AccessInfoRow
            label={t("security.access.row.identity", {
              defaultValue: "Identity",
            })}
            value={state.identity.displayName}
            detail={t("security.access.row.signedInAs", {
              kind: state.identity.kind,
              defaultValue: "Signed in as {{kind}}.",
            })}
          />
        )}
        {advancedEnabled && (
          <>
            <AccessInfoRow
              label={t("security.access.row.currentBrowser", {
                defaultValue: "Current browser",
              })}
              value={currentBrowserValue}
              detail={currentBrowserDetail}
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
                label={t("security.access.row.apiBase", {
                  defaultValue: "API base",
                })}
                value={trimTrailingSlash(apiBase)}
                detail={`${apiEndpointDescription.value}: ${apiEndpointDescription.detail}`}
              />
            )}
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button
          ref={accessRefreshRef}
          {...accessRefreshAgentProps}
          variant="ghost"
          size="sm"
          onClick={() => void onRefresh()}
          className="h-7 gap-1.5 px-1 text-xs text-muted transition-colors hover:bg-transparent hover:text-txt-strong"
        >
          <RefreshCw className="h-3 w-3" />
          {t("security.refresh", { defaultValue: "Refresh" })}
        </Button>
        <AdvancedToggle label="Advanced" />
      </div>
    </SectionShell>
  );
}

type SessionsState =
  | { phase: "loading" }
  | { phase: "loaded"; sessions: AuthSessionListEntry[] }
  | { phase: "error"; message: string };

function SessionsSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<SessionsState>({ phase: "loading" });
  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());
  const { ref: sessionsRefreshRef, agentProps: sessionsRefreshAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "security-sessions-refresh",
      role: "button",
      label: "Refresh active sessions",
      group: "security-sessions",
    });
  const { ref: revokeOthersRef, agentProps: revokeOthersAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "security-sessions-sign-out-everywhere",
      role: "button",
      label: "Sign out everywhere else",
      group: "security-sessions",
      description: "Revoke every session except the current one",
    });

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
            ? t("security.sessions.error.signInRequired", {
                defaultValue: "You must be signed in to view sessions.",
              })
            : t("security.sessions.error.loadFailed", {
                defaultValue:
                  "Could not load sessions. Try reloading the page.",
              }),
      });
    }
  }, [t]);

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
      title={t("security.sessions.title", {
        defaultValue: "Active sessions",
      })}
    >
      {state.phase === "loading" && (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("security.sessions.loading", {
            defaultValue: "Loading sessions...",
          })}
        </div>
      )}

      {state.phase === "error" && (
        <p className="py-2 text-sm text-danger">{state.message}</p>
      )}

      {state.phase === "loaded" && (
        <div className="space-y-3">
          {state.sessions.length === 0 ? (
            <p className="text-sm text-muted">
              {t("security.sessions.empty", {
                defaultValue: "No active sessions.",
              })}
            </p>
          ) : (
            <div className="flex flex-col">
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
            <Button
              ref={sessionsRefreshRef}
              {...sessionsRefreshAgentProps}
              variant="ghost"
              size="sm"
              onClick={load}
              className="h-7 gap-1.5 px-1 text-xs text-muted transition-colors hover:bg-transparent hover:text-txt-strong"
            >
              <RefreshCw className="h-3 w-3" />
              {t("security.refresh", { defaultValue: "Refresh" })}
            </Button>

            {state.sessions.filter((s) => !s.current).length > 1 && (
              <Button
                ref={revokeOthersRef}
                {...revokeOthersAgentProps}
                variant="outline"
                size="sm"
                onClick={handleRevokeOthers}
                className="border-danger/40 text-xs text-danger hover:bg-danger/10"
              >
                {t("security.sessions.signOutEverywhere", {
                  defaultValue: "Sign out everywhere else",
                })}
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionShell>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  revoking,
  onRevoke,
}: {
  session: AuthSessionListEntry;
  revoking: boolean;
  onRevoke: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { ref: revokeRef, agentProps: revokeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `security-session-revoke-${session.id}`,
      role: "button",
      label: `Revoke ${session.kind} session`,
      group: "security-sessions",
      onActivate: () => onRevoke(session.id),
    });
  return (
    <div className="flex items-start gap-3 py-3">
      <DeviceIcon userAgent={session.userAgent} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize text-txt-strong">
            {session.kind}
          </span>
          {session.current && (
            <span className="rounded-full border border-ok/35 bg-ok/12 px-2 py-0.5 text-xs font-medium text-ok">
              {t("security.sessions.thisSession", {
                defaultValue: "This session",
              })}
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted">
          {session.ip ??
            t("security.sessions.unknownIp", {
              defaultValue: "Unknown IP",
            })}{" "}
          &middot;{" "}
          {session.userAgent
            ? session.userAgent.slice(0, 60)
            : t("security.sessions.unknownClient", {
                defaultValue: "Unknown client",
              })}
        </p>
        <p className="text-xs text-muted">
          {t("security.sessions.lastSeenExpires", {
            lastSeen: formatRelativeTime(session.lastSeenAt),
            expires: formatRelativeTime(session.expiresAt),
            defaultValue: "Last seen {{lastSeen}} · expires {{expires}}",
          })}
        </p>
      </div>

      {!session.current && (
        <Button
          ref={revokeRef}
          {...revokeAgentProps}
          variant="ghost"
          size="sm"
          disabled={revoking}
          onClick={() => onRevoke(session.id)}
          className="shrink-0 text-xs text-danger hover:bg-danger/10 hover:text-danger"
          aria-label={t("security.sessions.revoke", {
            defaultValue: "Revoke this session",
          })}
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
});

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
  const { t } = useTranslation();
  const displayNameId = useId().replace(/:/g, "");
  const currentPasswordId = useId().replace(/:/g, "");
  const newPasswordId = useId().replace(/:/g, "");
  const confirmPasswordId = useId().replace(/:/g, "");

  const [displayName, setDisplayName] = useState("Owner");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<PasswordState>({ phase: "idle" });

  const { ref: displayNameRef, agentProps: displayNameAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "security-password-display-name",
      role: "text-input",
      label: "Owner display name",
      group: "security-password",
      getValue: () => displayName,
      onFill: (v) => setDisplayName(v),
    });
  const { ref: currentPasswordRef, agentProps: currentPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "security-password-current",
      role: "text-input",
      label: "Current password",
      group: "security-password",
      getValue: () => currentPassword,
      onFill: (v) => setCurrentPassword(v),
    });
  const { ref: newPasswordRef, agentProps: newPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "security-password-new",
      role: "text-input",
      label: "New remote password",
      group: "security-password",
      getValue: () => newPassword,
      onFill: (v) => setNewPassword(v),
    });
  const { ref: confirmPasswordRef, agentProps: confirmPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "security-password-confirm",
      role: "text-input",
      label: "Confirm new remote password",
      group: "security-password",
      getValue: () => confirmPassword,
      onFill: (v) => setConfirmPassword(v),
    });
  const { ref: passwordSubmitRef, agentProps: passwordSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "security-password-submit",
      role: "button",
      label: "Set or change remote password",
      group: "security-password",
    });

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
        setState({
          phase: "error",
          message: t("security.password.error.mismatch", {
            defaultValue: "New passwords do not match.",
          }),
        });
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
        message: t("security.password.success", {
          defaultValue:
            "Remote access enabled. Remote browsers can sign in with this password.",
        }),
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
      t,
    ],
  );

  if (accessState.phase === "loading") {
    return (
      <SectionShell
        icon={<KeyRound className="h-4 w-4 opacity-60" />}
        title={t("security.password.title", {
          defaultValue: "Remote password",
        })}
      >
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("security.password.loading", {
            defaultValue: "Loading password settings...",
          })}
        </div>
      </SectionShell>
    );
  }

  if (accessState.phase !== "loaded") {
    const message =
      accessState.phase === "locked" &&
      accessState.reason === "remote_password_not_configured"
        ? t("security.password.notEnabled", {
            defaultValue:
              "Remote access is not enabled. Open this instance on the host machine and set a remote password.",
          })
        : t("security.password.signInToManage", {
            defaultValue: "Sign in to manage the remote password.",
          });
    return (
      <SectionShell
        icon={<KeyRound className="h-4 w-4 opacity-60" />}
        title={t("security.password.title", {
          defaultValue: "Remote password",
        })}
      >
        <p className="text-sm text-muted">{message}</p>
      </SectionShell>
    );
  }

  const buttonLabel =
    setupMode || !accessState.access.passwordConfigured
      ? t("security.password.setButton", {
          defaultValue: "Set remote password",
        })
      : t("security.password.changeButton", {
          defaultValue: "Change remote password",
        });

  return (
    <SectionShell
      icon={<KeyRound className="h-4 w-4 opacity-60" />}
      title={t("security.password.title", {
        defaultValue: "Remote password",
      })}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
        {setupMode && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={displayNameId} className="text-xs text-muted">
              {t("security.password.field.displayName", {
                defaultValue: "Display name",
              })}
            </Label>
            <Input
              ref={displayNameRef}
              {...displayNameAgentProps}
              id={displayNameId}
              type="text"
              autoComplete="username"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                if (state.phase === "error") setState({ phase: "idle" });
              }}
              disabled={isSubmitting}
              className="h-11"
            />
          </div>
        )}

        {currentPasswordRequired && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={currentPasswordId} className="text-xs text-muted">
              {t("security.password.field.current", {
                defaultValue: "Current password",
              })}
            </Label>
            <Input
              ref={currentPasswordRef}
              {...currentPasswordAgentProps}
              id={currentPasswordId}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                if (state.phase === "error") setState({ phase: "idle" });
              }}
              disabled={isSubmitting}
              className="h-11"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={newPasswordId} className="text-xs text-muted">
            {t("security.password.field.new", {
              defaultValue: "New password",
            })}
          </Label>
          <Input
            ref={newPasswordRef}
            {...newPasswordAgentProps}
            id={newPasswordId}
            type="password"
            autoComplete="new-password"
            placeholder={t("security.password.field.newPlaceholder", {
              defaultValue: "At least 12 characters",
            })}
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
              if (state.phase === "error") setState({ phase: "idle" });
            }}
            disabled={isSubmitting}
            className="h-11"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={confirmPasswordId} className="text-xs text-muted">
            {t("security.password.field.confirm", {
              defaultValue: "Confirm new password",
            })}
          </Label>
          <Input
            ref={confirmPasswordRef}
            {...confirmPasswordAgentProps}
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
            className={cn("h-11", confirmMismatch && "border-danger ")}
          />
          {confirmMismatch && (
            <p className="text-xs text-danger">
              {t("security.password.error.mismatchShort", {
                defaultValue: "Passwords do not match.",
              })}
            </p>
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
          <Button
            ref={passwordSubmitRef}
            {...passwordSubmitAgentProps}
            type="submit"
            disabled={!canSubmit}
            size="sm"
          >
            {isSubmitting
              ? t("security.password.saving", { defaultValue: "Saving..." })
              : buttonLabel}
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
    <SettingsStack>
      <AccessModeSection state={accessState} onRefresh={refreshAccessState} />
      <RemotePasswordSection
        accessState={accessState}
        onAccessChanged={refreshAccessState}
      />
      <SessionsSection />
    </SettingsStack>
  );
}
