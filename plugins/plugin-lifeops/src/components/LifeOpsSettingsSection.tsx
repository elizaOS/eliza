import type { ModelOption } from "@elizaos/shared";
import {
  Button,
  client,
  dispatchFocusConnector,
  SegmentedControl,
  useApp,
} from "@elizaos/ui";
import {
  AlertTriangle,
  CalendarDays,
  ExternalLink,
  GitBranch,
  HardDrive,
  HeartPulse,
  Mail,
  Plug2,
  Sparkles,
  ToggleRight,
  Unplug,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  LifeOpsCalendarSummary,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
} from "../contracts/index.js";
import { useGoogleLifeOpsConnector } from "../hooks/useGoogleLifeOpsConnector";
import { LifeOpsFeatureTogglesSection } from "./LifeOpsFeatureTogglesSection";
import { MobileSignalsSetupCard } from "./MobileSignalsSetupCard";

const VISIBLE_CONNECTOR_MODES = ["local"] as const;
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

function capabilityItems(
  capabilities: readonly LifeOpsGoogleCapability[],
  t: TranslateFn,
): Array<{ key: "calendar" | "mail"; label: string }> {
  const items: Array<{ key: "calendar" | "mail"; label: string }> = [];
  if (
    capabilities.includes("google.calendar.read") ||
    capabilities.includes("google.calendar.write")
  ) {
    items.push({
      key: "calendar",
      label: t("lifeopssettings.capabilityCalendar", {
        defaultValue: "Cal",
      }),
    });
  }
  if (
    capabilities.includes("google.gmail.triage") ||
    capabilities.includes("google.gmail.send")
  ) {
    items.push({
      key: "mail",
      label: t("lifeopssettings.capabilityMail", {
        defaultValue: "Mail",
      }),
    });
  }
  return items;
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

type StatusTone = "ok" | "warning" | "muted";

function statusDotClassName(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]";
    case "warning":
      return "bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.14)]";
    default:
      return "bg-muted/45";
  }
}

function StatusDot({
  label,
  tone,
  className = "",
}: {
  label: string;
  tone: StatusTone;
  className?: string;
}) {
  return (
    <span
      aria-label={label}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClassName(tone)} ${className}`}
      role="img"
      title={label}
    />
  );
}

function IconOnlyLabel({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <span className="inline-flex items-center justify-center" title={label}>
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function ModeLabel({ label }: { label: string }) {
  return (
    <IconOnlyLabel label={label}>
      <HardDrive className="h-3.5 w-3.5" aria-hidden />
    </IconOnlyLabel>
  );
}

function MiniMeter({
  label,
  tone,
  total,
  value,
}: {
  label: string;
  tone: StatusTone;
  total: number;
  value: number;
}) {
  const boundedTotal = Math.max(total, 0);
  const boundedValue =
    boundedTotal > 0 ? Math.min(Math.max(value, 0), boundedTotal) : 0;
  const width =
    boundedTotal > 0 ? `${(boundedValue / boundedTotal) * 100}%` : "0%";
  const fill =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warning"
        ? "bg-amber-500"
        : "bg-muted/45";
  return (
    <span
      aria-label={label}
      className="relative inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-bg/70"
      role="img"
      title={label}
    >
      <span className={`h-full rounded-full ${fill}`} style={{ width }} />
    </span>
  );
}

type GoogleConnectorController = ReturnType<typeof useGoogleLifeOpsConnector>;

function GithubConnectButton({
  side,
  github,
  label,
}: {
  side: LifeOpsConnectorSide;
  github: GithubSetupState;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `settings-github-${side}-connect`,
    role: "button",
    label: `${label} GitHub (${side})`,
    group: "lifeops-github",
    description: `Connect the ${side} GitHub account`,
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      className="h-8 w-8 rounded-xl p-0"
      disabled={github.connectDisabled}
      onClick={github.onConnect}
      title={label}
      aria-label={label}
      {...agentProps}
    >
      <Plug2 className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function GithubDisconnectButton({
  side,
  github,
  label,
}: {
  side: LifeOpsConnectorSide;
  github: GithubSetupState;
  label: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `settings-github-${side}-disconnect`,
    role: "button",
    label: `${label} GitHub (${side})`,
    group: "lifeops-github",
    description: `Disconnect the ${side} GitHub account`,
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      className="h-8 w-8 rounded-xl p-0"
      disabled={github.disconnectDisabled}
      onClick={github.onDisconnect}
      title={label}
      aria-label={label}
      {...agentProps}
    >
      <Unplug className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function GithubRow({
  github,
  side,
}: {
  github: GithubSetupState;
  side: LifeOpsConnectorSide;
}) {
  const { t } = useApp();
  const identity = github.identity.trim();
  const identityLower = identity.toLowerCase();
  const showIdentity =
    identity.length > 0 &&
    identityLower !== "not linked" &&
    identityLower !== "no agent" &&
    identityLower !== "cloud required";
  const linked =
    github.status.trim().startsWith("1 /") ||
    (showIdentity && !identityLower.includes("not linked"));
  const tone: StatusTone = linked
    ? "ok"
    : github.connectDisabled
      ? "muted"
      : "warning";
  const status = linked
    ? t("lifeopssettings.connected", { defaultValue: "Connected" })
    : t("lifeopssettings.notConnected", { defaultValue: "Not connected" });
  return (
    <div className="space-y-2 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <GitBranch className="h-4 w-4 shrink-0" />
          <span>GitHub</span>
          <StatusDot label={status} tone={tone} />
        </div>
        {showIdentity ? (
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
            {identity}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {github.onConnect ? (
            <GithubConnectButton
              side={side}
              github={github}
              label={
                github.connectLabel ??
                t("common.connect", { defaultValue: "Connect" })
              }
            />
          ) : null}
          {github.onDisconnect ? (
            <GithubDisconnectButton
              side={side}
              github={github}
              label={t("common.disconnect", { defaultValue: "Disconnect" })}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GoogleManagementButton({
  side,
  label,
  disabled,
}: {
  side: LifeOpsConnectorSide;
  label: string;
  disabled: boolean;
}) {
  const { setActionNotice, setTab } = useApp();
  const openGoogleConnector = useCallback(() => {
    setTab("connectors");
    dispatchFocusConnector("google");
    setActionNotice(
      "Google account setup is managed in Connectors. Configure Google there, then refresh LifeOps.",
      "info",
      4200,
    );
  }, [setActionNotice, setTab]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `settings-google-${side}-manage`,
    role: "button",
    label: `${label} Google (${side})`,
    group: "lifeops-google",
    description: `Open the ${side} Google account in Connectors`,
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      className="h-8 w-8 rounded-xl p-0"
      disabled={disabled}
      onClick={openGoogleConnector}
      title={label}
      aria-label={label}
      {...agentProps}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function GoogleCalendarToggle({
  calendar,
  side,
  disabled,
  onToggle,
}: {
  calendar: LifeOpsCalendarSummary;
  side: LifeOpsConnectorSide;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: `settings-google-${side}-calendar-${calendar.grantId}-${calendar.calendarId}`,
    role: "toggle",
    label: `Include ${calendar.summary} in calendar feed`,
    group: "lifeops-google",
    status: calendar.includeInFeed ? "active" : "inactive",
    description: "Toggle whether this calendar is included in the LifeOps feed",
    getValue: () => calendar.includeInFeed,
    onActivate: () => {
      if (!disabled) onToggle();
    },
  });
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-card/18 px-3 py-2 text-xs">
      <input
        ref={ref}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-border bg-bg"
        checked={calendar.includeInFeed}
        disabled={disabled}
        onChange={onToggle}
        {...agentProps}
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
    error,
    loading,
    selectMode,
    status,
  } = connector;
  const [calendars, setCalendars] = useState<LifeOpsCalendarSummary[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarPendingId, setCalendarPendingId] = useState<string | null>(
    null,
  );
  const [calendarFeedOpen, setCalendarFeedOpen] = useState(false);
  const connectedAccounts = accounts.filter((account) => account.connected);
  const primaryIdentity = readIdentity(
    connectedAccounts[0]?.identity ?? status?.identity ?? null,
    t,
  );
  const emptyIdentityLabel = t("lifeopssettings.googleNotConnected", {
    defaultValue: "Google not connected",
  });
  const showPrimaryIdentity =
    status?.connected === true ||
    primaryIdentity.primary !== emptyIdentityLabel;
  const currentStatusLabel = statusLabel(
    status?.reason ?? "disconnected",
    status?.connected === true,
    t,
  );
  const currentStatusTone: StatusTone = status?.connected
    ? "ok"
    : status?.reason === "needs_reauth" ||
        status?.reason === "config_missing" ||
        status?.reason === "token_missing"
      ? "warning"
      : "muted";
  const controlDisabled = loading;
  const visibleMode: VisibleConnectorMode = "local";
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
          grantId: preferredGrantId ?? undefined,
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
  }, [side, status?.connected, status?.mode, preferredGrantId]);

  const toggleCalendar = useCallback(
    async (calendar: LifeOpsCalendarSummary) => {
      const pendingId = `${calendar.side}:${calendar.grantId}:${calendar.calendarId}`;
      setCalendarPendingId(pendingId);
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
    <section className="space-y-3 rounded-2xl border border-border/20 bg-card/14 px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg/38">
            <GoogleIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-txt">
                {sideTitle(side, t)}
              </div>
              <StatusDot label={currentStatusLabel} tone={currentStatusTone} />
            </div>
            {showPrimaryIdentity ? (
              <div className="mt-1 truncate text-sm font-semibold text-txt">
                {primaryIdentity.primary}
              </div>
            ) : null}
            {primaryIdentity.secondary ? (
              <div className="mt-0.5 truncate text-xs text-muted">
                {primaryIdentity.secondary}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <SegmentedControl<VisibleConnectorMode>
            aria-label={t("lifeopssettings.googleModeAria", {
              defaultValue: "{{side}} Google mode",
              side: sideTitle(side, t),
            })}
            value={visibleMode}
            onValueChange={(mode) => void selectMode(mode)}
            items={VISIBLE_CONNECTOR_MODES.map((mode) => ({
              value: mode,
              label: (
                <ModeLabel label={modeLabel(mode as LifeOpsConnectorMode, t)} />
              ),
              disabled: controlDisabled,
            }))}
            className="min-w-40 flex-1 bg-bg/40 p-0.5 sm:w-auto sm:flex-none"
            buttonClassName="min-h-8 flex-1 px-3 py-1.5 text-xs"
          />
          <GoogleManagementButton
            side={side}
            label={t("common.manage", { defaultValue: "Manage" })}
            disabled={controlDisabled}
          />
        </div>
      </div>

      {connectedAccounts.length > 0 ? (
        <div className="grid gap-2">
          {connectedAccounts.map((account) => {
            const accountIdentity = readIdentity(account.identity ?? null, t);
            const capabilities = capabilityItems(
              account.grantedCapabilities,
              t,
            );
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
                      <StatusDot
                        label={t("lifeopssettings.active", {
                          defaultValue: "Active",
                        })}
                        tone="ok"
                      />
                    ) : null}
                  </div>
                </div>
                {capabilities.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {capabilities.map((capability) => (
                      <span
                        key={capability.key}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/26 bg-card/28 text-muted"
                        title={capability.label}
                        aria-label={capability.label}
                        role="img"
                      >
                        {capability.key === "calendar" ? (
                          <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Mail className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {status?.connected ? (
        <details
          className="rounded-2xl bg-bg/30 px-3 py-3"
          open={calendarFeedOpen}
          onToggle={(event) => setCalendarFeedOpen(event.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-txt">
            <span className="inline-flex items-center gap-2">
              <CalendarDays className="h-3.5 w-3.5 text-muted" aria-hidden />
              {t("lifeopssettings.calendarFeedTitle", {
                defaultValue: "Calendar feed",
              })}
            </span>
            {calendarError ? (
              <AlertTriangle
                className="h-3.5 w-3.5 text-danger"
                aria-label={t("lifeopssettings.calendarFeedIssue", {
                  defaultValue: "Issue",
                })}
                role="img"
              />
            ) : calendars.length > 0 ? (
              <MiniMeter
                label={`${calendars.filter((calendar) => calendar.includeInFeed).length}/${calendars.length}`}
                tone="ok"
                total={calendars.length}
                value={
                  calendars.filter((calendar) => calendar.includeInFeed).length
                }
              />
            ) : null}
          </summary>
          <div className="mt-3 space-y-2">
            {calendarLoading ? (
              <StatusDot
                label={t("lifeopssettings.loadingCalendars", {
                  defaultValue: "Reading calendars",
                })}
                tone="muted"
              />
            ) : calendars.length > 0 ? (
              <div className="grid gap-2">
                {calendars.map((calendar) => {
                  const calendarIdentity = `${calendar.side}:${calendar.grantId}:${calendar.calendarId}`;
                  const disabled =
                    controlDisabled || calendarPendingId === calendarIdentity;
                  return (
                    <GoogleCalendarToggle
                      key={calendarIdentity}
                      calendar={calendar}
                      side={side}
                      disabled={disabled}
                      onToggle={() => void toggleCalendar(calendar)}
                    />
                  );
                })}
              </div>
            ) : (
              <StatusDot
                label={t("lifeopssettings.noCalendars", {
                  defaultValue: "Calendars clear",
                })}
                tone="muted"
              />
            )}
            {calendarError ? (
              <div className="text-xs text-danger">{calendarError}</div>
            ) : null}
          </div>
        </details>
      ) : null}

      {error ? <div className="text-xs text-danger">{error}</div> : null}
      <GithubRow github={github} side={side} />
    </section>
  );
}

function HealthConnectorRedirectCard() {
  const { setActionNotice, setTab, t } = useApp();
  const openLabel = t("lifeopssettings.openHealthConnectorSettings", {
    defaultValue: "Open health connector settings",
  });
  const openHealthSettings = useCallback(() => {
    setTab("connectors");
    dispatchFocusConnector("health");
    setActionNotice(
      "Health connector setup is managed by plugin-health. Configure health providers there, then return to LifeOps.",
      "info",
      4200,
    );
  }, [setActionNotice, setTab]);
  const open = useAgentElement<HTMLButtonElement>({
    id: "settings-health-open-connector",
    role: "button",
    label: openLabel,
    group: "lifeops-health",
    description: "Open plugin-health connector setup",
    onActivate: openHealthSettings,
  });

  return (
    <section className="flex items-center justify-between gap-3 rounded-2xl border border-border/20 bg-card/14 px-4 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg/38">
          <HeartPulse className="h-4 w-4 text-muted" aria-hidden />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-txt">
            {t("lifeopssettings.healthConnectorsTitle", {
              defaultValue: "Health",
            })}
          </h3>
          <StatusDot label="plugin-health owns setup" tone="muted" />
        </div>
      </div>
      <Button
        ref={open.ref}
        size="sm"
        className="h-8 w-8 rounded-xl p-0"
        onClick={openHealthSettings}
        title={openLabel}
        aria-label={openLabel}
        {...open.agentProps}
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </section>
  );
}

function BrowserBridgeRedirectCard() {
  const { setActionNotice, setTab, t } = useApp();
  const openLabel = t("lifeopssettings.openBrowserBridgeSettings", {
    defaultValue: "Open browser bridge settings",
  });
  const openBrowserSettings = useCallback(() => {
    setTab("browser");
    setActionNotice(
      "Browser bridge setup is managed by plugin-browser. Configure browser companions there, then refresh LifeOps.",
      "info",
      4200,
    );
  }, [setActionNotice, setTab]);
  const open = useAgentElement<HTMLButtonElement>({
    id: "settings-browser-bridge-open",
    role: "button",
    label: openLabel,
    group: "lifeops-browser-bridge",
    description: "Open plugin-browser bridge setup",
    onActivate: openBrowserSettings,
  });

  return (
    <section className="flex items-center justify-between gap-3 rounded-2xl border border-border/20 bg-card/14 px-4 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg/38">
          <HardDrive className="h-4 w-4 text-muted" aria-hidden />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-txt">
            {t("lifeopssettings.browserBridgeTitle", {
              defaultValue: "Browser bridge",
            })}
          </h3>
          <StatusDot label="plugin-browser owns setup" tone="muted" />
        </div>
      </div>
      <Button
        ref={open.ref}
        size="sm"
        className="h-8 w-8 rounded-xl p-0"
        onClick={openBrowserSettings}
        title={openLabel}
        aria-label={openLabel}
        {...open.agentProps}
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </section>
  );
}

function flattenModelOptions(
  models:
    | {
        nano?: ModelOption[];
        small?: ModelOption[];
        medium?: ModelOption[];
        large?: ModelOption[];
        mega?: ModelOption[];
      }
    | undefined,
): ModelOption[] {
  if (!models) return [];
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  // Smart features run on the small-model tier by default — surface those
  // first so the most appropriate ids are at the top of the dropdown.
  for (const tier of ["small", "nano", "medium", "large", "mega"] as const) {
    const list = models[tier];
    if (!list) continue;
    for (const opt of list) {
      if (seen.has(opt.id)) continue;
      seen.add(opt.id);
      out.push(opt);
    }
  }
  return out;
}

function SmartFeaturesCard() {
  const { t } = useApp();
  const [enabled, setEnabled] = useState<boolean>(true);
  const [model, setModel] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await client.getLifeOpsAppState();
        if (cancelled) return;
        setEnabled(state.priorityScoring.enabled !== false);
        setModel(state.priorityScoring.model ?? "");
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const opts = await client.getFirstRunOptions();
        if (cancelled) return;
        setModelOptions(flattenModelOptions(opts.models));
      } catch {
        // First-run options can fail on first boot; the dropdown then falls
        // back to a free-text input. No need to surface this as an error.
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (next: { enabled: boolean; model: string }) => {
      setSaving(true);
      try {
        const previous = await client.getLifeOpsAppState();
        const saved = await client.updateLifeOpsAppState({
          enabled: previous.enabled,
          priorityScoring: {
            enabled: next.enabled,
            model: next.model.trim().length > 0 ? next.model.trim() : null,
          },
        });
        setEnabled(saved.priorityScoring.enabled !== false);
        setModel(saved.priorityScoring.model ?? "");
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handleToggle = useCallback(
    () => void persist({ enabled: !enabled, model }),
    [enabled, model, persist],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      setModel(value);
      void persist({ enabled, model: value });
    },
    [enabled, persist],
  );

  const enableToggle = useAgentElement<HTMLInputElement>({
    id: "settings-smart-priority-toggle",
    role: "toggle",
    label: "Enable LLM priority scoring",
    group: "lifeops-smart-features",
    status: enabled ? "active" : "inactive",
    description: "Toggle LLM-based inbox priority scoring",
    getValue: () => enabled,
    onActivate: () => {
      if (!loading && !saving) handleToggle();
    },
  });
  const modelOptionIds = useMemo(
    () => ["", ...modelOptions.map((opt) => opt.id)],
    [modelOptions],
  );
  const modelSelect = useAgentElement<HTMLSelectElement>({
    id: "settings-smart-priority-model",
    role: modelOptions.length > 0 ? "select" : "text-input",
    label: "Priority scoring model",
    group: "lifeops-smart-features",
    description: "Model used to score inbox messages for priority",
    options: modelOptions.length > 0 ? modelOptionIds : undefined,
    getValue: () => model,
    onFill: (value: string) => handleModelChange(value),
  });
  const modelInputRef = modelSelect.ref as unknown as Ref<HTMLInputElement>;

  return (
    <section className="space-y-3 rounded-2xl border border-border/20 bg-card/14 px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg/38">
          <Sparkles className="h-4 w-4 text-muted" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-txt">
            {t("lifeopssettings.smartFeaturesTitle", {
              defaultValue: "Smart features",
            })}
          </h3>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-xl bg-bg/40 px-3 py-2 text-xs">
        <span className="font-medium text-txt">
          {t("lifeopssettings.priorityScoringEnable", {
            defaultValue: "Enable LLM priority scoring",
          })}
        </span>
        <input
          ref={enableToggle.ref}
          type="checkbox"
          className="h-4 w-4"
          checked={enabled}
          disabled={loading || saving}
          onChange={handleToggle}
          {...enableToggle.agentProps}
        />
      </label>

      <div className="space-y-1">
        <label
          className="text-xs font-medium text-txt"
          htmlFor="lifeops-priority-scoring-model"
        >
          {t("lifeopssettings.priorityScoringModel", {
            defaultValue: "Model",
          })}
        </label>
        {modelOptions.length > 0 ? (
          <select
            ref={modelSelect.ref}
            id="lifeops-priority-scoring-model"
            className="w-full rounded-xl border border-border/30 bg-bg/40 px-2.5 py-1.5 text-xs text-txt"
            value={model}
            disabled={loading || saving || optionsLoading || !enabled}
            onChange={(e) => handleModelChange(e.target.value)}
            title={t("lifeopssettings.priorityScoringModelHint", {
              defaultValue:
                "Model id passed to runtime.useModel. Leave blank to use the runtime default small model.",
            })}
            {...modelSelect.agentProps}
          >
            <option value="">
              {t("lifeopssettings.priorityScoringDefaultModel", {
                defaultValue: "Default (small/fast model from runtime)",
              })}
            </option>
            {modelOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name} ({opt.provider})
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={modelInputRef}
            id="lifeops-priority-scoring-model"
            type="text"
            className="w-full rounded-xl border border-border/30 bg-bg/40 px-2.5 py-1.5 text-xs text-txt"
            placeholder={t("lifeopssettings.priorityScoringModelPlaceholder", {
              defaultValue: "e.g. claude-haiku-4-5, gpt-5-mini",
            })}
            value={model}
            disabled={loading || saving || !enabled}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => handleModelChange(model)}
            {...modelSelect.agentProps}
            title={t("lifeopssettings.priorityScoringModelHint", {
              defaultValue:
                "Model id passed to runtime.useModel. Leave blank to use the runtime default small model.",
            })}
          />
        )}
      </div>

      {error ? <div className="text-xs text-danger">{error}</div> : null}
    </section>
  );
}

function EmailIntelligenceCard() {
  const { t } = useApp();
  const [enabled, setEnabled] = useState<boolean>(true);
  const [autoExtract, setAutoExtract] = useState<boolean>(true);
  const [model, setModel] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await client.getLifeOpsSmartFeatureSettings();
        if (cancelled) return;
        setEnabled(settings.emailClassifierEnabled);
        setAutoExtract(settings.billsAutoExtract);
        setModel(
          settings.emailClassifierModel === "TEXT_SMALL"
            ? ""
            : settings.emailClassifierModel,
        );
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const opts = await client.getFirstRunOptions();
        if (cancelled) return;
        setModelOptions(flattenModelOptions(opts.models));
      } catch {
        // First-run options can fail before the backend has discovered any
        // providers — UI then falls back to a free-text input.
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (next: { enabled: boolean; autoExtract: boolean; model: string }) => {
      setSaving(true);
      try {
        await client.updateLifeOpsSmartFeatureSettings({
          emailClassifierEnabled: next.enabled,
          emailClassifierModel:
            next.model.trim().length > 0 ? next.model.trim() : "TEXT_SMALL",
          billsAutoExtract: next.autoExtract,
        });
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const onToggleEnabled = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    void persist({ enabled: next, autoExtract, model });
  }, [enabled, autoExtract, model, persist]);

  const onToggleAutoExtract = useCallback(() => {
    const next = !autoExtract;
    setAutoExtract(next);
    void persist({ enabled, autoExtract: next, model });
  }, [enabled, autoExtract, model, persist]);

  const onModelChange = useCallback(
    (value: string) => {
      setModel(value);
      void persist({ enabled, autoExtract, model: value });
    },
    [enabled, autoExtract, persist],
  );

  const enableToggle = useAgentElement<HTMLInputElement>({
    id: "settings-email-classifier-toggle",
    role: "toggle",
    label: "Enable email classification",
    group: "lifeops-email-intelligence",
    status: enabled ? "active" : "inactive",
    description: "Toggle email classification with the LLM classifier",
    getValue: () => enabled,
    onActivate: () => {
      if (!loading && !saving) onToggleEnabled();
    },
  });
  const autoExtractToggle = useAgentElement<HTMLInputElement>({
    id: "settings-email-auto-extract-toggle",
    role: "toggle",
    label: "Auto-extract bills into Money",
    group: "lifeops-email-intelligence",
    status: autoExtract ? "active" : "inactive",
    description: "Toggle automatic extraction of bills into the Money dashboard",
    getValue: () => autoExtract,
    onActivate: () => {
      if (!loading && !saving && enabled) onToggleAutoExtract();
    },
  });
  const modelOptionIds = useMemo(
    () => ["", ...modelOptions.map((opt) => opt.id)],
    [modelOptions],
  );
  const modelSelect = useAgentElement<HTMLSelectElement>({
    id: "settings-email-classifier-model",
    role: modelOptions.length > 0 ? "select" : "text-input",
    label: "Email classifier model",
    group: "lifeops-email-intelligence",
    description: "Model used to classify ambiguous emails",
    options: modelOptions.length > 0 ? modelOptionIds : undefined,
    getValue: () => model,
    onFill: (value: string) => onModelChange(value),
  });
  const modelInputRef = modelSelect.ref as unknown as Ref<HTMLInputElement>;

  return (
    <section className="space-y-3 rounded-2xl border border-border/20 bg-card/14 px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg/38">
          <Mail className="h-4 w-4 text-muted" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-txt">
            {t("lifeopssettings.emailIntelligenceTitle", {
              defaultValue: "Email intelligence",
            })}
          </h3>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-xl bg-bg/40 px-3 py-2 text-xs">
        <span className="font-medium text-txt">
          {t("lifeopssettings.emailClassifierEnable", {
            defaultValue: "Enable email classification",
          })}
        </span>
        <input
          ref={enableToggle.ref}
          type="checkbox"
          className="h-4 w-4"
          checked={enabled}
          disabled={loading || saving}
          onChange={onToggleEnabled}
          {...enableToggle.agentProps}
        />
      </label>

      <label className="flex items-center justify-between gap-3 rounded-xl bg-bg/40 px-3 py-2 text-xs">
        <span className="font-medium text-txt">
          {t("lifeopssettings.billsAutoExtract", {
            defaultValue: "Auto-extract bills into Money",
          })}
        </span>
        <input
          ref={autoExtractToggle.ref}
          type="checkbox"
          className="h-4 w-4"
          checked={autoExtract}
          disabled={loading || saving || !enabled}
          onChange={onToggleAutoExtract}
          {...autoExtractToggle.agentProps}
        />
      </label>

      <div className="space-y-1">
        <label
          className="text-xs font-medium text-txt"
          htmlFor="lifeops-email-classifier-model"
        >
          {t("lifeopssettings.emailClassifierModel", {
            defaultValue: "Email classifier model",
          })}
        </label>
        {modelOptions.length > 0 ? (
          <select
            ref={modelSelect.ref}
            id="lifeops-email-classifier-model"
            className="w-full rounded-xl border border-border/30 bg-bg/40 px-2.5 py-1.5 text-xs text-txt"
            value={model}
            disabled={loading || saving || optionsLoading || !enabled}
            onChange={(event) => onModelChange(event.target.value)}
            title={t("lifeopssettings.emailClassifierModelHint", {
              defaultValue:
                "Model used only for ambiguous emails. Leave blank to use the runtime default small model.",
            })}
            {...modelSelect.agentProps}
          >
            <option value="">
              {t("lifeopssettings.emailClassifierDefaultModel", {
                defaultValue: "Default (small/fast model from runtime)",
              })}
            </option>
            {modelOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name} ({opt.provider})
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={modelInputRef}
            id="lifeops-email-classifier-model"
            type="text"
            className="w-full rounded-xl border border-border/30 bg-bg/40 px-2.5 py-1.5 text-xs text-txt"
            placeholder="e.g. claude-haiku-4-5, gpt-5-mini"
            value={model}
            disabled={loading || saving || !enabled}
            onChange={(event) => setModel(event.target.value)}
            onBlur={() => onModelChange(model)}
            title={t("lifeopssettings.emailClassifierModelHint", {
              defaultValue:
                "Model used only for ambiguous emails. Leave blank to use the runtime default small model.",
            })}
            {...modelSelect.agentProps}
          />
        )}
      </div>

      {error ? <div className="text-xs text-danger">{error}</div> : null}
    </section>
  );
}

function CloudActionButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "settings-cloud-action",
    role: "button",
    label,
    group: "lifeops-settings",
    description: "Run the LifeOps cloud setup action",
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      className="h-8 rounded-xl px-3 text-xs font-semibold"
      onClick={onClick}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

export function LifeOpsSettingsSection({
  ownerGithub = DEFAULT_OWNER_GITHUB,
  agentGithub = DEFAULT_AGENT_GITHUB,
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
      {cloudAction ? (
        <div className="flex justify-end">
          <CloudActionButton
            label={cloudAction.label}
            onClick={cloudAction.onClick}
          />
        </div>
      ) : null}

      <MobileSignalsSetupCard />
      <HealthConnectorRedirectCard />

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

      <BrowserBridgeRedirectCard />

      <SmartFeaturesCard />

      <EmailIntelligenceCard />

      <section className="space-y-3 rounded-2xl border border-border/20 bg-card/14 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg/38">
            <ToggleRight className="h-4 w-4 text-muted" aria-hidden />
          </div>
          <h3 className="text-sm font-semibold text-txt">
            {t("lifeopssettings.featuresTitle", {
              defaultValue: "Features",
            })}
          </h3>
        </div>
        <LifeOpsFeatureTogglesSection />
      </section>
    </section>
  );
}
