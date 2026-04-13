import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
} from "@elizaos/shared/contracts/lifeops";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@elizaos/app-core";
import {
  CalendarDays,
  Mail,
  Plug2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useMemo } from "react";
import { useGoogleLifeOpsConnector } from "@elizaos/app-core/hooks";
import { useApp } from "@elizaos/app-core/state";
import {
  resolveLifeOpsLocalGoogleRedirectUri,
  resolveLifeOpsRemoteGoogleRedirectUri,
  resolveLifeOpsSettingsApiBaseUrl,
} from "@elizaos/app-core/utils";
import { LifeOpsBrowserSetupPanel } from "./LifeOpsBrowserSetupPanel";

function modeLabel(mode: LifeOpsConnectorMode): string {
  switch (mode) {
    case "cloud_managed":
      return "Cloud";
    case "remote":
      return "Remote";
    default:
      return "Local";
  }
}

function modeTone(mode: LifeOpsConnectorMode): "secondary" | "outline" {
  return mode === "cloud_managed" ? "secondary" : "outline";
}

function capabilityLabel(capability: LifeOpsGoogleCapability): string {
  switch (capability) {
    case "google.calendar.read":
      return "Calendar read";
    case "google.calendar.write":
      return "Calendar write";
    case "google.gmail.triage":
      return "Gmail triage";
    case "google.gmail.send":
      return "Gmail send";
    default:
      return "Identity";
  }
}

function statusLabel(reason: string, connected: boolean): string {
  if (connected) {
    return "Connected";
  }
  switch (reason) {
    case "needs_reauth":
      return "Needs reauth";
    case "config_missing":
      return "Needs setup";
    case "token_missing":
      return "Token missing";
    default:
      return "Disconnected";
  }
}

function readIdentity(identity: Record<string, unknown> | null): {
  primary: string;
  secondary: string | null;
} {
  if (!identity) {
    return {
      primary: "Google not connected",
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
    primary: name ?? email ?? "Google connected",
    secondary: name && email ? email : null,
  };
}

function formatExpiry(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

type GoogleConnectorController = ReturnType<typeof useGoogleLifeOpsConnector>;

function sideTitle(side: LifeOpsConnectorSide): string {
  return side === "owner" ? "Owner setup" : "Agent setup";
}

function sideDescription(side: LifeOpsConnectorSide): string {
  return side === "owner"
    ? "Connect the owner’s Google account."
    : "Connect the Google account the agent should use as itself.";
}

function connectorSetupDetails(
  side: LifeOpsConnectorSide,
  activeMode: LifeOpsConnectorMode,
  apiBaseUrl: URL,
) {
  if (activeMode === "cloud_managed") {
    return {
      eyebrow: "Recommended",
      title: "Managed by Eliza Cloud",
      lines: [
        side === "owner"
          ? "Use this when the owner’s Google account should stay in managed cloud storage."
          : "Use this when the agent’s own Google account should stay in managed cloud storage.",
        "Google refresh tokens stay in cloud-managed storage and this agent uses Gmail and Calendar through the managed gateway.",
      ],
      envVars: [] as string[],
      redirectUri: null as string | null,
    };
  }

  if (activeMode === "remote") {
    return {
      eyebrow: "Self-hosted",
      title: "Remote web OAuth",
      lines: [
        "Use a Google Web OAuth client for a self-hosted deployment.",
        "Register the exact redirect URI shown below with Google.",
        "If your Google app is still in testing, add the relevant Google account to the allowlist before connecting.",
      ],
      envVars: [
        "ELIZA_GOOGLE_OAUTH_WEB_CLIENT_ID",
        "ELIZA_GOOGLE_OAUTH_WEB_CLIENT_SECRET",
        "ELIZA_GOOGLE_OAUTH_PUBLIC_BASE_URL",
      ],
      redirectUri: resolveLifeOpsRemoteGoogleRedirectUri(apiBaseUrl),
    };
  }

  return {
    eyebrow: "Advanced",
    title: "Local desktop OAuth",
    lines: [
      side === "owner"
        ? "Use a desktop OAuth client when the owner’s Google tokens should stay on this machine."
        : "Use a desktop OAuth client when the agent account’s Google tokens should stay on this machine.",
      "Set the desktop client id before connecting. If your Google app is still in testing, add the account to the test-user allowlist first.",
      "The app handles the local callback itself on the API loopback address shown below.",
    ],
    envVars: ["ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID"],
    redirectUri: resolveLifeOpsLocalGoogleRedirectUri(apiBaseUrl),
  };
}

function GoogleConnectorSideCard({
  apiBaseUrl,
  connector,
  side,
}: {
  apiBaseUrl: URL;
  connector: GoogleConnectorController;
  side: LifeOpsConnectorSide;
}) {
  const {
    activeMode,
    actionPending,
    connect,
    disconnect,
    error,
    loading,
    modeOptions,
    refresh,
    selectMode,
    status,
  } = connector;
  const identity = readIdentity(status?.identity ?? null);
  const capabilityBadges = status?.grantedCapabilities ?? [];
  const expiresAtLabel = formatExpiry(status?.expiresAt ?? null);
  const currentStatusLabel = statusLabel(
    status?.reason ?? "disconnected",
    status?.connected === true,
  );
  const setupDetails = useMemo(
    () => connectorSetupDetails(side, activeMode, apiBaseUrl),
    [activeMode, apiBaseUrl, side],
  );

  return (
    <Card className="border-border/60 bg-bg/20">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{sideTitle(side)}</Badge>
              {status?.preferredByAgent ? (
                <Badge variant="secondary">Default on this agent</Badge>
              ) : null}
            </div>
            <div className="text-sm text-muted">{sideDescription(side)}</div>
          </div>
          <div className="flex items-center gap-2">
            {status?.connected && !status.preferredByAgent ? (
              <Button
                size="sm"
                variant="outline"
                disabled={loading || actionPending}
                onClick={() => void selectMode(activeMode)}
                aria-label={`Use ${sideTitle(side)} by default`}
              >
                Use by default
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={loading || actionPending}
              onClick={() => void refresh()}
              aria-label={`Refresh ${sideTitle(side)}`}
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button
              size="sm"
              variant={status?.connected ? "outline" : "default"}
              disabled={loading || actionPending}
              onClick={() =>
                void (status?.connected ? disconnect() : connect())
              }
              aria-label={`${status?.connected ? "Disconnect" : status?.reason === "needs_reauth" ? "Reconnect" : "Connect"} ${sideTitle(side)}`}
            >
              {status?.connected
                ? "Disconnect"
                : status?.reason === "needs_reauth"
                  ? "Reconnect"
                  : "Connect"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-2xl border border-border/60 bg-bg/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
              {identity.primary}
            </span>
            <Badge variant={modeTone(activeMode)}>
              {modeLabel(activeMode)}
            </Badge>
            <Badge variant="outline">{currentStatusLabel}</Badge>
          </div>
          {identity.secondary ? (
            <div className="mt-1 text-sm text-muted">{identity.secondary}</div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {modeOptions.map((mode) => {
              const isActive = mode === activeMode;
              return (
                <Button
                  key={mode}
                  size="sm"
                  variant={isActive ? "default" : "outline"}
                  disabled={loading || actionPending}
                  onClick={() => void selectMode(mode)}
                  aria-label={`${sideTitle(side)} ${modeLabel(mode)} mode`}
                >
                  {modeLabel(mode)}
                </Button>
              );
            })}
          </div>
          {expiresAtLabel ? (
            <div className="mt-3 text-xs text-muted">
              Token state last known valid until {expiresAtLabel}.
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <Card className="border-border/60 bg-bg/20">
            <CardHeader className="space-y-2 pb-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt">
                <ShieldCheck className="h-4 w-4 text-muted" />
                Current access
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {capabilityBadges.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {capabilityBadges.map((capability) => (
                    <Badge key={capability} variant="secondary">
                      {capabilityLabel(capability)}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No Google capabilities have been granted on this setup yet.
                </p>
              )}
              <div className="grid gap-2 text-sm text-muted">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  Calendar read powers event context and scheduling.
                </div>
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4" />
                  Gmail triage powers inbox prioritization and draft context.
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-bg/20">
            <CardHeader className="space-y-2 pb-3">
              <div className="flex items-center gap-2">
                <Badge variant={modeTone(activeMode)}>
                  {setupDetails.eyebrow}
                </Badge>
                <CardTitle className="text-sm font-semibold">
                  {setupDetails.title}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted">
              {setupDetails.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {setupDetails.envVars.length > 0 ? (
                <div className="rounded-xl border border-border/60 bg-bg/40 p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                    Required config
                  </div>
                  <div className="mt-2 space-y-1 font-mono text-xs text-txt">
                    {setupDetails.envVars.map((envVar) => (
                      <div key={envVar}>{envVar}</div>
                    ))}
                  </div>
                </div>
              ) : null}
              {setupDetails.redirectUri ? (
                <div className="rounded-xl border border-border/60 bg-bg/40 p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                    Redirect URI
                  </div>
                  <div className="mt-2 break-all font-mono text-xs text-txt">
                    {setupDetails.redirectUri}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {error ? <div className="text-sm text-danger">{error}</div> : null}
      </CardContent>
    </Card>
  );
}

export function LifeOpsSettingsSection() {
  const { t: translate } = useApp();
  const ownerConnector = useGoogleLifeOpsConnector({ side: "owner" });
  const agentConnector = useGoogleLifeOpsConnector({ side: "agent" });
  const apiBaseUrl = useMemo(() => resolveLifeOpsSettingsApiBaseUrl(), []);
  const t =
    typeof translate === "function" ? translate : (key: string): string => key;

  return (
    <div className="space-y-4">
      <Card className="border-border/60">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <Plug2 className="h-4 w-4 text-muted" />
            <CardTitle className="text-base font-semibold">
              {t("settings.sections.lifeops.label")}
            </CardTitle>
          </div>
          <p className="max-w-3xl text-sm text-muted">
            Keep separate Google setups for the owner and the agent. Each side
            can use Cloud or Local OAuth, and the connected mode you pick can be
            used as the default Google account for this agent.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <GoogleConnectorSideCard
            apiBaseUrl={apiBaseUrl}
            connector={ownerConnector}
            side="owner"
          />
          <GoogleConnectorSideCard
            apiBaseUrl={apiBaseUrl}
            connector={agentConnector}
            side="agent"
          />
        </CardContent>
      </Card>
      <LifeOpsBrowserSetupPanel />
    </div>
  );
}
