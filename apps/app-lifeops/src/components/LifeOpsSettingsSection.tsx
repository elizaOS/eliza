import {
  Badge,
  Button,
  SegmentedControl,
  useApp,
  useMediaQuery,
} from "@elizaos/app-core";
import { client } from "@elizaos/app-core/api";
import type {
  LifeOpsCalendarSummary,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
} from "@elizaos/app-lifeops/contracts";
import { Copy, ExternalLink, GitBranch, Plug2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useGoogleLifeOpsConnector } from "../hooks/useGoogleLifeOpsConnector";
import { BrowserBridgeSetupPanel } from "./BrowserBridgeSetupPanel.tsx";
import { MobileSignalsSetupCard } from "./MobileSignalsSetupCard";

const MAX_GOOGLE_ACCOUNTS_PER_SIDE = 6;
const VISIBLE_CONNECTOR_MODES = ["cloud_managed", "local"] as const;
type VisibleConnectorMode = (typeof VISIBLE_CONNECTOR_MODES)[number];

type TranslateFn = (
  key: string,
  options?: Record<string, unknown> & { defaultValue?: string },
) => string;

export type GithubSetupState = {
  identity: string;
  status: string;
  connectLabel?: string;
  connectDisabled?: boolean;
  disconnectDisabled?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
};

export interface LifeOpsSettingsSectionProps {
  ownerGithub?: GithubSetupState;
  agentGithub?: GithubSetupState;
  githubError?: string | null;
  cloudAction?: {
    label: string;
    onClick: () => void;
  } | null;
}

const DEFAULT_OWNER_GITHUB: GithubSetupState = {
  identity: "",
  status: "",
};

const DEFAULT_AGENT_GITHUB: GithubSetupState = {
  identity: "",
  status: "",
};

function statusLabel(
  reason: string,
  connected: boolean,
  t: TranslateFn,
): string {
  if (connected) {
    return t("lifeopssettings.connected", {
      defaultValue: "Connected",
    });
  }
  switch (reason) {
    case "needs_reauth":
      return t("lifeopssettings.needsReauth", {
        defaultValue: "Needs reauth",
      });
    case "config_missing":
      return t("lifeopssettings.needsSetup", {
        defaultValue: "Needs setup",
      });
    case "token_missing":
      return t("lifeopssettings.tokenMissing", {
        defaultValue: "Token missing",
      });
    default:
      return t("lifeopssettings.notConnected", {
        defaultValue: "Not connected",
      });
  }
}

function readIdentity(
  identity: Record<string, unknown> | null,
  t: TranslateFn,
): {
  primary: string;
  secondary: string | null;
} {
  if (!identity) {
    return {
      primary: t("lifeopssettings.googleNotConnected", {
        defaultValue: "Google not connected",
      }),
      secondary: null,
    };
  }
  const name =
    typeof identity.name === "string" && identity.name.trim().length > 0
      ? identity.name.trim()
      : null;
  const email =
    typeof identity.email === "string" && identity.email.trim().length > 0
      ? identity.email.trim()
      : null;
  return {
    primary:
      name ??
      email ??
      t("lifeopssettings.googleConnected", {
        defaultValue: "Google connected",
      }),
    secondary: name && email ? email : null,
  };
}

function modeLabel(mode: LifeOpsConnectorMode, t: TranslateFn): string {
  return mode === "local"
    ? t("lifeopssettings.local", {
        defaultValue: "Local",
      })
    : t("lifeopssettings.cloud", {
        defaultValue: "Cloud",
      });
}

function sideTitle(side: LifeOpsConnectorSide, t: TranslateFn): string {
  return side === "owner"
    ? t("lifeopssettings.user", {
        defaultValue: "User",
      })
    : t("chat.agentType", {
        defaultValue: "Agent",
      });
}

function capabilityLabels(
  capabilities: readonly LifeOpsGoogleCapability[],
  t: TranslateFn,
): string[] {
  const labels: string[] = [];
  if (
    capabilities.includes("google.calendar.read") ||
    capabilities.includes("google.calendar.write")
  ) {
    labels.push(
      t("lifeopssettings.capabilityCalendar", {
        defaultValue: "Cal",
      }),
    );
  }
  if (
    capabilities.includes("google.gmail.triage") ||
    capabilities.includes("google.gmail.send")
  ) {
    labels.push(
      t("lifeopssettings.capabilityMail", {
        defaultValue: "Mail",
      }),
    );
  }
  return labels;
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

type GoogleConnectorController = ReturnType<typeof useGoogleLifeOpsConnector>;

function PendingAuthBanner({
  url,
  onDismiss,
}: {
  url: string;
  onDismiss: () => void;
}) {
  const { t } = useApp();
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(url);
  }, [url]);

  const handleOpen = useCallback(() => {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "accounts.google.com"
    ) {
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  return (
    <div className="rounded-2xl bg-card/22 px-3 py-3 text-xs text-muted">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 rounded-lg px-2 text-[11px] font-semibold"
          onClick={() => void handleCopy()}
        >
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          {t("lifeopssettings.copyUrl", {
            defaultValue: "Copy URL",
          })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 rounded-lg px-2 text-[11px] font-semibold"
          onClick={handleOpen}
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          {t("common.open", {
            defaultValue: "Open",
          })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-lg px-2 text-[11px] font-semibold"
          onClick={onDismiss}
        >
          {t("common.dismiss", {
            defaultValue: "Dismiss",
          })}
        </Button>
      </div>
    </div>
  );
}

function GithubRow({
  github,
  compactLayout,
}: {
  github: GithubSetupState;
  compactLayout: boolean;
}) {
  const { t } = useApp();
  return (
    <div className="space-y-2 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <GitBranch className="h-4 w-4 shrink-0" />
          <span>GitHub</span>
        </div>
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
          {github.identity}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {github.onConnect ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={github.connectDisabled}
              onClick={github.onConnect}
            >
              {github.connectLabel ??
                t("common.connect", {
                  defaultValue: "Connect",
                })}
            </Button>
          ) : null}
          {github.onDisconnect ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={github.disconnectDisabled}
              onClick={github.onDisconnect}
            >
              {t("common.disconnect", {
                defaultValue: "Disconnect",
              })}
            </Button>
          ) : null}
        </div>
      </div>
      {!compactLayout && github.status.trim().length > 0 ? (
        <div className="text-xs text-muted">{github.status}</div>
      ) : null}
    </div>
  );
}

function GoogleConnectorSideCard({
  connector,
  side,
  github,
}: {
  connector: GoogleConnectorController;
  side: LifeOpsConnectorSide;
  github: GithubSetupState;
}) {
  const { t } = useApp();
  const {
    accounts,
    activeMode,
    actionPending,
    connect,
    connectAdditional,
    disconnect,
    disconnectAccount,
    error,
    loading,
    pendingAuthUrl,
    selectMode,
    status,
  } = connector;
  const [dismissedAuthUrl, setDismissedAuthUrl] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<LifeOpsCalendarSummary[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarPendingId, setCalendarPendingId] = useState<string | null>(null);
  const compactLayout = useMediaQuery("(max-width: 767px)");
  const connectedAccounts = accounts.filter((account) => account.connected);
  const primaryIdentity = readIdentity(
    connectedAccounts[0]?.identity ?? status?.identity ?? null,
    t,
  );
  const currentStatusLabel = statusLabel(
    status?.reason ?? "disconnected",
    status?.connected === true,
    t,
  );
  const controlDisabled = loading || actionPending;
  const visibleMode: VisibleConnectorMode =
    activeMode === "local" ? "local" : "cloud_managed";
  const visibleAuthUrl =
    pendingAuthUrl && pendingAuthUrl !== dismissedAuthUrl
      ? pendingAuthUrl
      : null;
  const preferredGrantId = status?.grant?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!status?.connected) {
      setCalendars([]);
      setCalendarError(null);
      setCalendarLoading(false);
      return;
    }
    const loadCalendars = async () => {
      setCalendarLoading(true);
      setCalendarError(null);
      try {
        const response = await client.getLifeOpsCalendars({
          side,
          mode: status.mode,
        });
        if (!cancelled) {
          setCalendars(response.calendars);
        }
      } catch (cause) {
        if (!cancelled) {
          setCalendarError(
            cause instanceof Error && cause.message.trim().length > 0
              ? cause.message.trim()
              : "Could not load calendars.",
          );
        }
      } finally {
        if (!cancelled) {
          setCalendarLoading(false);
        }
      }
    };
    void loadCalendars();
    return () => {
      cancelled = true;
    };
  }, [side, status?.connected, status?.mode]);

  const toggleCalendar = useCallback(
    async (calendar: LifeOpsCalendarSummary) => {
      setCalendarPendingId(calendar.calendarId);
      setCalendarError(null);
      try {
        const response = await client.setLifeOpsCalendarIncluded({
          calendarId: calendar.calendarId,
          includeInFeed: !calendar.includeInFeed,
          side,
          mode: status?.mode,
          grantId: calendar.grantId,
        });
        setCalendars((current) =>
          current.map((entry) =>
            entry.calendarId === response.calendar.calendarId &&
            entry.grantId === response.calendar.grantId
              ? response.calendar
              : entry,
          ),
        );
      } catch (cause) {
        setCalendarError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Could not update calendar visibility.",
        );
      } finally {
        setCalendarPendingId(null);
      }
    },
    [side, status?.mode],
  );

  return (
    <section className="space-y-3 px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold text-txt">
          {sideTitle(side, t)}
        </div>
      </div>

      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-txt">
          {primaryIdentity.primary}
        </div>
        {primaryIdentity.secondary ? (
          <div className="mt-1 truncate text-xs text-muted">
            {primaryIdentity.secondary}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <GoogleIcon className="h-4 w-4 shrink-0" />
          <span>Google</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<VisibleConnectorMode>
            aria-label={t("lifeopssettings.googleModeAria", {
              defaultValue: "{{side}} Google mode",
              side: sideTitle(side, t),
            })}
            value={visibleMode}
            onValueChange={(mode) => void selectMode(mode)}
            items={VISIBLE_CONNECTOR_MODES.map((mode) => ({
              value: mode,
              label: modeLabel(mode, t),
              disabled: controlDisabled,
            }))}
            className="w-full bg-bg/40 p-0.5 sm:w-auto"
            buttonClassName="min-h-8 flex-1 px-3 py-1.5 text-xs"
          />
          {!status?.connected ? (
            <Button
              size="sm"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={controlDisabled}
              onClick={() => void connect()}
            >
              {status?.reason === "needs_reauth"
                ? t("common.reconnect", {
                    defaultValue: "Reconnect",
                  })
                : t("common.connect", {
                    defaultValue: "Connect",
                  })}
            </Button>
          ) : null}
          {status?.connected &&
          connectedAccounts.length < MAX_GOOGLE_ACCOUNTS_PER_SIDE ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={controlDisabled}
              onClick={() => void connectAdditional()}
            >
              {t("common.add", {
                defaultValue: "Add",
              })}
            </Button>
          ) : null}
          {status?.connected && connectedAccounts.length <= 1 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={controlDisabled}
              onClick={() => void disconnect()}
            >
              {t("common.disconnect", {
                defaultValue: "Disconnect",
              })}
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={status?.connected ? "text-xs text-ok" : "text-xs text-muted"}
      >
        {currentStatusLabel}
      </div>

      {connectedAccounts.length > 0 ? (
        <div className="grid gap-2">
          {connectedAccounts.map((account) => {
            const accountIdentity = readIdentity(account.identity ?? null, t);
            const labels = capabilityLabels(account.grantedCapabilities, t);
            const isPreferred =
              preferredGrantId != null &&
              account.grant?.id === preferredGrantId;
            return (
              <div
                key={account.grant?.id ?? accountIdentity.primary}
                className="rounded-2xl bg-bg/40 px-3 py-2 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-txt">
                    {accountIdentity.primary}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {isPreferred ? (
                      <Badge variant="secondary" className="text-3xs">
                        {t("lifeopssettings.active", {
                          defaultValue: "Active",
                        })}
                      </Badge>
                    ) : null}
                    {account.grant?.id ? (
                      <button
                        type="button"
                        className="text-muted transition-colors hover:text-danger"
                        aria-label={t("lifeopssettings.disconnectAccount", {
                          defaultValue: "Disconnect {{label}}",
                          label: accountIdentity.primary,
                        })}
                        disabled={controlDisabled}
                        onClick={() => {
                          if (!account.grant?.id) return;
                          void disconnectAccount(account.grant.id);
                        }}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </div>
                {labels.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {labels.map((label) => (
                      <Badge key={label} variant="outline" className="text-3xs">
                        {label}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {status?.connected ? (
        <div className="space-y-2 rounded-2xl bg-bg/30 px-3 py-3">
          <div className="text-xs font-semibold text-txt">
            {t("lifeopssettings.calendarFeedTitle", {
              defaultValue: "Which calendars appear in your feed?",
            })}
          </div>
          <div className="text-xs leading-5 text-muted">
            {t("lifeopssettings.calendarFeedDescription", {
              defaultValue:
                "These toggles affect the sidebar feed and proactive briefings. Direct calendar actions still read every authorized calendar.",
            })}
          </div>
          {calendarLoading ? (
            <div className="text-xs text-muted">
              {t("lifeopssettings.loadingCalendars", {
                defaultValue: "Loading calendars…",
              })}
            </div>
          ) : calendars.length > 0 ? (
            <div className="grid gap-2">
              {calendars.map((calendar) => {
                const disabled =
                  controlDisabled || calendarPendingId === calendar.calendarId;
                return (
                  <label
                    key={`${calendar.grantId}:${calendar.calendarId}`}
                    className="flex cursor-pointer items-start gap-3 rounded-xl bg-card/18 px-3 py-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-border bg-bg"
                      checked={calendar.includeInFeed}
                      disabled={disabled}
                      onChange={() => void toggleCalendar(calendar)}
                    />
                    <span
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          calendar.backgroundColor ?? "rgba(148, 163, 184, 0.8)",
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-txt">
                        {calendar.summary}
                      </span>
                      <span className="block truncate text-muted">
                        {calendar.accountEmail ?? calendar.calendarId}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-muted">
              {t("lifeopssettings.noCalendars", {
                defaultValue: "No readable calendars found for this connector.",
              })}
            </div>
          )}
        </div>
      ) : null}

      {visibleAuthUrl ? (
        <PendingAuthBanner
          url={visibleAuthUrl}
          onDismiss={() => setDismissedAuthUrl(visibleAuthUrl)}
        />
      ) : null}
      {error ? <div className="text-xs text-danger">{error}</div> : null}
      {calendarError ? (
        <div className="text-xs text-danger">{calendarError}</div>
      ) : null}

      <GithubRow github={github} compactLayout={compactLayout} />
    </section>
  );
}

export function LifeOpsSettingsSection({
  ownerGithub = DEFAULT_OWNER_GITHUB,
  agentGithub = DEFAULT_AGENT_GITHUB,
  githubError = null,
  cloudAction = null,
}: LifeOpsSettingsSectionProps = {}) {
  const { t } = useApp();
  const ownerConnector = useGoogleLifeOpsConnector({
    includeAccounts: true,
    side: "owner",
  });
  const agentConnector = useGoogleLifeOpsConnector({
    includeAccounts: true,
    side: "agent",
  });
  const resolvedOwnerGithub =
    ownerGithub.identity || ownerGithub.status
      ? ownerGithub
      : {
          ...ownerGithub,
          identity: t("lifeopssettings.ownerGithubNotLinked", {
            defaultValue: "LifeOps owner GitHub not linked",
          }),
          status: t("lifeopssettings.notConnected", {
            defaultValue: "Not connected",
          }),
        };
  const resolvedAgentGithub =
    agentGithub.identity || agentGithub.status
      ? agentGithub
      : {
          ...agentGithub,
          identity: t("lifeopssettings.agentGithubNotLinked", {
            defaultValue: "Agent GitHub not linked",
          }),
          status: t("lifeopssettings.notConnected", {
            defaultValue: "Not connected",
          }),
        };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-semibold text-txt">
          {t("lifeopssettings.accounts", {
            defaultValue: "Accounts",
          })}
        </div>
        {cloudAction ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={cloudAction.onClick}
          >
            {cloudAction.label}
          </Button>
        ) : null}
      </div>

      {githubError ? (
        <div className="py-1 text-xs text-muted">{githubError}</div>
      ) : null}

      <MobileSignalsSetupCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <GoogleConnectorSideCard
          connector={ownerConnector}
          side="owner"
          github={resolvedOwnerGithub}
        />
        <GoogleConnectorSideCard
          connector={agentConnector}
          side="agent"
          github={resolvedAgentGithub}
        />
      </div>

      <BrowserBridgeSetupPanel />
    </section>
  );
}
