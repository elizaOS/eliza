import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
} from "@elizaos/shared/contracts/lifeops";
import {
  Badge,
  Button,
} from "@elizaos/app-core";
import {
  Plug2,
  RefreshCw,
} from "lucide-react";
import { useMemo } from "react";
import { useGoogleLifeOpsConnector } from "@elizaos/app-core";
import { useApp } from "@elizaos/app-core";
import {
  resolveLifeOpsLocalGoogleRedirectUri,
  resolveLifeOpsRemoteGoogleRedirectUri,
  resolveLifeOpsSettingsApiBaseUrl,
} from "@elizaos/app-core";
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
  const currentStatusLabel = statusLabel(
    status?.reason ?? "disconnected",
    status?.connected === true,
  );
  const setupDetails = useMemo(
    () => connectorSetupDetails(side, activeMode, apiBaseUrl),
    [activeMode, apiBaseUrl, side],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{sideTitle(side)}</Badge>
          {status?.preferredByAgent ? (
            <Badge variant="secondary">Default</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {status?.connected && !status.preferredByAgent ? (
            <Button
              size="sm"
              variant="outline"
              disabled={loading || actionPending}
              onClick={() => void selectMode(activeMode)}
            >
              Use by default
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={loading || actionPending}
            onClick={() => void refresh()}
          >
            <RefreshCw className="mr-1.5 h-3 w-3" />
            Refresh
          </Button>
          <Button
            size="sm"
            variant={status?.connected ? "outline" : "default"}
            disabled={loading || actionPending}
            onClick={() =>
              void (status?.connected ? disconnect() : connect())
            }
          >
            {status?.connected
              ? "Disconnect"
              : status?.reason === "needs_reauth"
                ? "Reconnect"
                : "Connect"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 truncate font-semibold text-txt">
          {identity.primary}
        </span>
        <Badge variant={modeTone(activeMode)}>
          {modeLabel(activeMode)}
        </Badge>
        <Badge variant="outline">{currentStatusLabel}</Badge>
        {capabilityBadges.map((capability) => (
          <Badge key={capability} variant="secondary" className="text-2xs">
            {capabilityLabel(capability)}
          </Badge>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {modeOptions.map((mode) => {
          const isActive = mode === activeMode;
          return (
            <Button
              key={mode}
              size="sm"
              variant={isActive ? "default" : "outline"}
              disabled={loading || actionPending}
              onClick={() => void selectMode(mode)}
            >
              {modeLabel(mode)}
            </Button>
          );
        })}
      </div>

      {setupDetails.envVars.length > 0 ? (
        <div className="rounded-lg border border-border/50 bg-bg/40 px-3 py-2">
          <span className="text-xs font-semibold text-muted">Config: </span>
          <span className="font-mono text-xs text-txt">
            {setupDetails.envVars.join(", ")}
          </span>
        </div>
      ) : null}
      {setupDetails.redirectUri ? (
        <div className="rounded-lg border border-border/50 bg-bg/40 px-3 py-2">
          <span className="text-xs font-semibold text-muted">Redirect URI: </span>
          <span className="break-all font-mono text-xs text-txt">
            {setupDetails.redirectUri}
          </span>
        </div>
      ) : null}

      {error ? <div className="text-xs text-danger">{error}</div> : null}
    </div>
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
      <div className="flex items-center gap-2 text-muted">
        <Plug2 className="h-4 w-4" />
        <div className="text-xs font-semibold uppercase tracking-wide">
          {t("settings.sections.lifeops.label")}
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
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
      </div>
      <LifeOpsBrowserSetupPanel />
    </div>
  );
}
