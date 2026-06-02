import type { LifeOpsOwnerBrowserAccessStatus } from "@elizaos/shared";
import {
  Button,
  dispatchFocusConnector,
  openExternalUrl,
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  HardDrive,
  Loader2,
  MessageCircle,
  Phone,
  Plug2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useDiscordConnector } from "../hooks/useDiscordConnector.js";
import { useIMessageConnector } from "../hooks/useIMessageConnector.js";
import { useSignalConnector } from "../hooks/useSignalConnector.js";
import { useTelegramConnector } from "../hooks/useTelegramConnector.js";
import { useWhatsAppConnector } from "../hooks/useWhatsAppConnector.js";

function isIosRuntime(): boolean {
  if (
    typeof navigator !== "undefined" &&
    /iPad|iPhone|iPod/.test(navigator.userAgent)
  ) {
    return true;
  }
  const capacitor = (
    globalThis as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor;
  return capacitor?.getPlatform?.() === "ios";
}

const MACOS_FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

type ConnectorStatusVariant = "ok" | "muted" | "warning";

const CONNECTOR_STATUS_DOT_CLASS: Record<ConnectorStatusVariant, string> = {
  ok: "bg-emerald-500",
  muted: "bg-muted/40",
  warning: "bg-amber-500",
};

function ConnectorCardShell({
  icon,
  platform,
  status,
  statusVariant,
  children,
}: {
  icon: ReactNode;
  platform: string;
  status: string;
  statusVariant: ConnectorStatusVariant;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-border/20 bg-card/14 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <span className="text-sm font-medium text-txt">{platform}</span>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${CONNECTOR_STATUS_DOT_CLASS[statusVariant]}`}
            title={status}
            aria-label={status}
            role="img"
          />
        </div>
      </div>
      {children}
    </div>
  );
}

function AccessPips({
  items,
  label,
}: {
  items: ConnectorStatusVariant[];
  label: string;
}) {
  const dots = items.length > 0 ? items : ["muted" as const];
  const slots = ["a", "b", "c", "d", "e", "f"] as const;
  return (
    <span
      aria-label={label}
      className="inline-flex items-center gap-1"
      role="img"
      title={label}
    >
      {slots.slice(0, dots.slice(0, 6).length).map((slot, slotIndex) => {
        const tone = dots[slotIndex];
        const color =
          tone === "muted" ? "bg-muted/45" : CONNECTOR_STATUS_DOT_CLASS[tone];
        return (
          <span key={slot} className={`h-1.5 w-1.5 rounded-full ${color}`} />
        );
      })}
    </span>
  );
}

function SignalIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M19.11 4.93A9.9 9.9 0 0 0 12.04 2c-5.5 0-9.96 4.45-9.96 9.94 0 1.75.46 3.47 1.34 4.99L2 22l5.23-1.37a9.97 9.97 0 0 0 4.81 1.23h.01c5.49 0 9.95-4.45 9.95-9.94a9.87 9.87 0 0 0-2.89-6.99ZM12.05 20.2h-.01a8.25 8.25 0 0 1-4.2-1.14l-.3-.18-3.1.81.83-3.02-.2-.31a8.22 8.22 0 0 1-1.28-4.42 8.29 8.29 0 0 1 8.3-8.27c2.22 0 4.31.86 5.87 2.42a8.2 8.2 0 0 1 2.43 5.85 8.29 8.29 0 0 1-8.34 8.26Zm4.53-6.18c-.25-.12-1.48-.73-1.71-.82-.23-.08-.39-.12-.56.12-.16.24-.64.82-.78.98-.14.16-.29.18-.54.06-.25-.12-1.05-.39-2-.24-.74.33-1.37-1.11-1.52-1.35-.14-.24-.02-.37.11-.49.11-.11.25-.29.37-.43.12-.14.16-.24.24-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.34-.77-1.84-.2-.48-.4-.41-.56-.42h-.48c-.16 0-.43.06-.65.31-.22.24-.85.83-.85 2.03 0 1.19.87 2.35.99 2.51.12.16 1.7 2.59 4.12 3.63.58.25 1.03.4 1.38.51.58.18 1.1.15 1.52.09.46-.07 1.48-.61 1.69-1.2.21-.59.21-1.09.15-1.2-.06-.11-.22-.18-.47-.3Z" />
    </svg>
  );
}

function browserAccessTitle(access: LifeOpsOwnerBrowserAccessStatus): string {
  if (access.source === "discord_desktop") {
    return "Discord Desktop App";
  }
  if (access.source === "desktop_browser") {
    return "Eliza Desktop Browser";
  }
  const browserLabel = access.browser === "safari" ? "Safari" : "Chrome";
  const profileLabel = access.profileLabel?.trim() || "Default profile";
  return `Your Browser · ${browserLabel} / ${profileLabel}`;
}

function browserAccessBadge(access: LifeOpsOwnerBrowserAccessStatus): {
  label: string;
  tone: "ok" | "warning" | "muted";
} {
  if (isBrowserAccessReady(access)) {
    return {
      label: access.tabState === "dm_inbox_visible" ? "Using now" : "Ready",
      tone: "ok",
    };
  }
  if (access.active || access.available) {
    return { label: "Available", tone: "warning" };
  }
  return { label: "Not ready", tone: "muted" };
}

function isBrowserAccessReady(
  access: LifeOpsOwnerBrowserAccessStatus,
): boolean {
  return (
    access.canControl &&
    access.siteAccessOk !== false &&
    access.nextAction === "none" &&
    (access.tabState === "dm_inbox_visible" ||
      access.tabState === "discord_open" ||
      access.tabState === "background_discord")
  );
}

function BrowserAccessStatusIcon({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "warning" | "muted";
}) {
  const className =
    tone === "ok"
      ? "text-emerald-500"
      : tone === "warning"
        ? "text-amber-500"
        : "text-muted/55";
  const Icon =
    tone === "ok"
      ? CheckCircle2
      : tone === "warning"
        ? CircleAlert
        : CircleDashed;
  return (
    <span
      aria-label={label}
      className={`inline-flex h-5 w-5 items-center justify-center ${className}`}
      role="img"
      title={label}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

function browserAccessSourceLabel(
  access: LifeOpsOwnerBrowserAccessStatus | null | undefined,
): string {
  if (!access) {
    return "your browser";
  }
  return access.source === "desktop_browser"
    ? "Eliza Desktop Browser"
    : access.source === "discord_desktop"
      ? "Discord Desktop"
      : "Your Browser";
}

function browserAccessActionLabel(
  action: LifeOpsOwnerBrowserAccessStatus["nextAction"] | null | undefined,
): string | null {
  switch (action) {
    case "connect_browser":
      return "Connect Your Browser";
    case "open_extension_popup":
      return "Open Extension Popup";
    case "enable_browser_access":
      return "Turn On Browser Access";
    case "enable_browser_control":
      return "Enable Browser Control";
    case "open_discord":
      return "Open Discord";
    case "open_dm_inbox":
      return "Open Discord DMs";
    case "focus_discord_manually":
      return "Open Discord Manually";
    case "focus_dm_inbox_manually":
      return "Focus DMs Manually";
    case "log_in":
      return "Log In to Discord";
    case "open_desktop_browser":
      return "Open Eliza Desktop";
    case "relaunch_discord":
      return "Relaunch Discord";
    default:
      return null;
  }
}

function browserAccessMessage(access: LifeOpsOwnerBrowserAccessStatus): string {
  const sourceLabel = browserAccessSourceLabel(access);
  if (access.source === "discord_desktop") {
    if (access.nextAction === "relaunch_discord") {
      return "Relaunch Discord with local agent control enabled. This keeps your existing Discord login.";
    }
    if (access.authState === "logged_out") {
      return "Discord Desktop is controllable, but that session still needs you to log in.";
    }
    if (access.tabState === "missing") {
      return "Discord Desktop control is on, but no Discord page target was found yet.";
    }
    if (
      access.authState === "logged_in" &&
      access.tabState !== "dm_inbox_visible"
    ) {
      return "Discord Desktop is connected, but the DM inbox is not visible yet.";
    }
    return "Discord Desktop is ready for local agent control.";
  }
  if (access.source === "lifeops_browser") {
    if (!access.available && access.nextAction === "enable_browser_access") {
      return access.active
        ? "Browser access is paused in Agent Browser Bridge settings."
        : "Browser access is turned off in Agent Browser Bridge settings.";
    }
    if (access.nextAction === "connect_browser") {
      return "No browser profile is connected yet. Install the extension, then open its popup in the browser profile that has your account.";
    }
    if (access.nextAction === "open_extension_popup") {
      return "A browser was paired before, but no profile is connected right now. Reopen the extension popup in the browser profile you want LifeOps to use.";
    }
    if (access.authState === "logged_out") {
      return `Discord is open in ${sourceLabel}, but that profile still needs you to log in.`;
    }
    if (!access.canControl && access.tabState === "missing") {
      return `${sourceLabel} is connected, but browser control is off, so LifeOps cannot open Discord for you.`;
    }
    if (!access.canControl && access.tabState !== "dm_inbox_visible") {
      return `${sourceLabel} can see Discord, but browser control is off. Focus the Discord DM tab manually or turn browser control on.`;
    }
    if (access.siteAccessOk === false) {
      return `${sourceLabel} is connected, but Discord has not been granted yet in this profile. Open Discord there and retry.`;
    }
    if (access.tabState === "missing") {
      return `${sourceLabel} is connected, but Discord is not open in that browser profile yet.`;
    }
    if (
      access.authState === "logged_in" &&
      access.tabState !== "dm_inbox_visible"
    ) {
      return `${sourceLabel} sees your Discord session, but not the DM inbox yet.`;
    }
    return `${sourceLabel} is ready for Discord.`;
  }

  if (access.nextAction === "open_desktop_browser") {
    return "Open Eliza Desktop to use its built-in browser for your Discord session.";
  }
  if (access.authState === "logged_out") {
    return "Discord is open in Eliza Desktop Browser, but that session still needs you to log in.";
  }
  if (access.tabState === "missing") {
    return "Eliza Desktop Browser is available, but Discord is not open there yet.";
  }
  if (
    access.authState === "logged_in" &&
    access.tabState !== "dm_inbox_visible"
  ) {
    return "Eliza Desktop Browser sees your Discord session, but not the DM inbox yet.";
  }
  return "Eliza Desktop Browser is ready for Discord.";
}

function ConnectorManagementButton({
  provider,
  platform,
  label = "Open in Connectors",
  disabled,
}: {
  provider: "discord" | "signal" | "telegram" | "whatsapp";
  platform: string;
  label?: string;
  disabled?: boolean;
}) {
  const { setActionNotice, setTab } = useApp();
  const handleOpen = useCallback(() => {
    setTab("connectors");
    dispatchFocusConnector(provider);
    setActionNotice(
      `${platform} setup is managed in Connectors. Configure the connector account there, then refresh LifeOps status.`,
      "info",
      4200,
    );
  }, [platform, provider, setActionNotice, setTab]);

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `connector-${provider}-manage`,
    role: "button",
    label: `${label}: ${platform}`,
    group: "lifeops-connectors",
    description: `Open ${platform} in the Connectors settings`,
  });

  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      className="h-8 rounded-xl px-3 text-xs font-semibold"
      disabled={disabled}
      onClick={handleOpen}
      title={`${label}: ${platform}`}
      aria-label={`${label}: ${platform}`}
      {...agentProps}
    >
      <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      {label}
    </Button>
  );
}

function ConnectorActionButton({
  agentId,
  label,
  description,
  children,
  ...buttonProps
}: {
  agentId: string;
  label: string;
  description: string;
  children: ReactNode;
} & ComponentProps<typeof Button>) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "lifeops-connectors",
    description,
  });
  return (
    <Button ref={ref} {...buttonProps} {...agentProps}>
      {children}
    </Button>
  );
}

function ConnectorTextInput({
  agentId,
  label,
  description,
  value,
  onChange,
  onSubmit,
  ...inputProps
}: {
  agentId: string;
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
} & Omit<ComponentProps<"input">, "value" | "onChange">) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: "text-input",
    label,
    group: "lifeops-connectors",
    description,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
      }}
      {...inputProps}
      {...agentProps}
    />
  );
}

function ManagedConnectorChip({
  platform,
  message,
}: {
  platform: string;
  message: string | null | undefined;
}) {
  const title =
    message ??
    `${platform} setup is managed by its connector plugin, not by LifeOps.`;
  return (
    <span
      aria-label={`${platform} setup managed in Connectors`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600"
      role="img"
      title={title}
    >
      <Plug2 className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function ConnectorPipSummary({
  label,
  items,
}: {
  label: string;
  items: ConnectorStatusVariant[];
}) {
  return (
    <div className="inline-flex h-8 items-center rounded-xl bg-bg/24 px-2">
      <AccessPips items={items} label={label} />
    </div>
  );
}

export function SignalConnectorCard() {
  const signal = useSignalConnector();
  const isConnected = signal.status?.connected === true;
  const inboundReady = signal.status?.inbound === true;
  const sendReady =
    signal.status?.grantedCapabilities.includes("signal.send") === true;
  const fullyReady = isConnected && inboundReady && sendReady;
  const busy = signal.loading;
  const statusLabel =
    signal.loading && !signal.status
      ? "Checking..."
      : isConnected
        ? fullyReady
          ? "Connected"
          : inboundReady
            ? "Connected, send limited"
            : sendReady
              ? "Connected, inbound off"
              : "Connected, capabilities missing"
        : "Managed in Connectors";
  const statusVariant: ConnectorStatusVariant = fullyReady
    ? "ok"
    : isConnected || signal.setupManagedByPlugin || signal.error || signal.loading
      ? "warning"
      : "muted";

  return (
    <ConnectorCardShell
      icon={<SignalIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Signal"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      {!isConnected ? (
        <div className="flex flex-wrap items-center gap-2">
          <ManagedConnectorChip
            platform="Signal"
            message={signal.pluginManagedMessage}
          />
          <ConnectorManagementButton
            provider="signal"
            platform="Signal"
            disabled={busy}
          />
          <ConnectorActionButton
            agentId="connector-signal-refresh-managed"
            label="Refresh Signal"
            description="Refresh Signal connector status"
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void signal.refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            {signal.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
          </ConnectorActionButton>
        </div>
      ) : null}

      {isConnected ? (
        <div className="space-y-2">
          {signal.status.identity?.phoneNumber ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Phone className="h-3.5 w-3.5" />
              {signal.status.identity.phoneNumber}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorPipSummary
              items={[inboundReady ? "ok" : "warning", sendReady ? "ok" : "warning"]}
              label={`Signal inbound ${inboundReady ? "ready" : "not ready"}, send ${sendReady ? "ready" : "not ready"}`}
            />
            <ConnectorManagementButton
              provider="signal"
              platform="Signal"
              label="Manage"
              disabled={busy}
            />
            <ConnectorActionButton
              agentId="connector-signal-refresh"
              label="Refresh Signal"
              description="Refresh Signal connector status"
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void signal.refresh()}
              title="Refresh"
              aria-label="Refresh"
            >
              {signal.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </ConnectorActionButton>
          </div>
        </div>
      ) : null}

      {signal.error ? (
        <div className="text-xs text-danger">{signal.error}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function DiscordConnectorCard() {
  const discord = useDiscordConnector();
  const busy = discord.loading;
  const username = discord.status?.identity?.username;
  const browserAccess = discord.status?.browserAccess ?? [];
  const activeDmInboxAccess =
    browserAccess.find(
      (access) => access.active && access.tabState === "dm_inbox_visible",
    ) ?? null;
  const isConnected =
    discord.status?.connected === true || Boolean(activeDmInboxAccess);
  const discordDesktopAccess =
    browserAccess.find((access) => access.source === "discord_desktop") ?? null;
  const dmInboxVisible =
    discord.status?.dmInbox.visible === true || Boolean(activeDmInboxAccess);
  const canRelaunchDiscord =
    discordDesktopAccess?.nextAction === "relaunch_discord";
  const preferredDiscordDesktopAccess =
    !dmInboxVisible && canRelaunchDiscord
      ? discordDesktopAccess
      : discordDesktopAccess?.active
        ? discordDesktopAccess
        : null;
  const preferredAccess =
    preferredDiscordDesktopAccess ??
    browserAccess.find((access) => access.active) ??
    browserAccess.find((access) => access.available) ??
    discordDesktopAccess ??
    browserAccess[0] ??
    null;
  const available =
    discord.status?.available === true ||
    browserAccess.some((access) => access.available);
  const visibleDmCount = discord.status?.dmInbox.count ?? 0;
  const lastError = canRelaunchDiscord ? null : discord.status?.lastError;
  const visibleDmLabels =
    discord.status?.dmInbox.previews
      ?.map((preview) => preview.label)
      .filter((label, index, labels) => labels.indexOf(label) === index)
      .slice(0, 3) ?? [];
  const pairing =
    discord.status?.reason === "pairing" ||
    preferredAccess?.nextAction === "open_discord" ||
    preferredAccess?.nextAction === "open_dm_inbox" ||
    preferredAccess?.nextAction === "relaunch_discord";
  const authPending =
    discord.status?.reason === "auth_pending" ||
    preferredAccess?.authState === "logged_out";
  const preferredActionLabel = browserAccessActionLabel(
    preferredAccess?.nextAction,
  );
  const statusLabel = dmInboxVisible
    ? `Connected / ${visibleDmCount} DM${visibleDmCount === 1 ? "" : "s"} visible`
    : authPending
      ? `Log in to Discord in ${browserAccessSourceLabel(preferredAccess)}`
      : preferredAccess?.nextAction === "relaunch_discord"
        ? "Relaunch Discord"
        : preferredAccess?.nextAction === "enable_browser_control"
          ? "Enable browser control"
          : preferredAccess?.nextAction === "connect_browser" ||
              preferredAccess?.nextAction === "open_extension_popup"
            ? "Connect Your Browser"
            : preferredAccess?.nextAction === "open_desktop_browser"
              ? "Open Eliza Desktop"
              : !available
                ? "Browser access unavailable"
                : isConnected
                  ? "Connected, opening DM inbox"
                  : pairing
                    ? `Opening Discord in ${browserAccessSourceLabel(preferredAccess)}…`
                    : "Not connected";
  const statusVariant: ConnectorStatusVariant = isConnected
    ? dmInboxVisible
      ? "ok"
      : "warning"
    : pairing || authPending || preferredActionLabel
      ? "warning"
      : "muted";
  const browserAccessTones = browserAccess.map((access) =>
    isBrowserAccessReady(access)
      ? "ok"
      : access.active || access.available
        ? "warning"
      : "muted",
  );

  return (
    <ConnectorCardShell
      icon={<DiscordIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Discord"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ConnectorManagementButton
          provider="discord"
          platform="Discord"
          label={isConnected ? "Manage" : "Open in Connectors"}
          disabled={busy}
        />
        <ConnectorActionButton
          agentId="connector-discord-refresh"
          label="Refresh Discord"
          description="Refresh Discord connector status"
          size="sm"
          variant="outline"
          className="h-8 w-8 rounded-xl p-0"
          disabled={busy}
          onClick={() => void discord.refresh()}
          title="Refresh"
          aria-label="Refresh"
        >
          {discord.loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
        </ConnectorActionButton>
      </div>

      {isConnected ? (
        <div className="space-y-2">
          {username ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <MessageCircle className="h-3.5 w-3.5" />
              {String(username)}
            </div>
          ) : null}
          {dmInboxVisible ? (
            <div className="text-xs text-muted">
              {visibleDmLabels.length > 0
                ? visibleDmLabels.join(", ")
                : "DM inbox visible"}
            </div>
          ) : null}
        </div>
      ) : null}

      {browserAccess.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <ConnectorPipSummary
            items={browserAccessTones}
            label={`${browserAccess.length} browser sources`}
          />
          {browserAccess.slice(0, 3).map((access) => {
            const badge = browserAccessBadge(access);
            return (
              <BrowserAccessStatusIcon
                key={`${access.source}:${access.browser ?? "desktop"}:${access.profileId ?? "default"}`}
                label={`${browserAccessTitle(access)}: ${badge.label}; ${browserAccessMessage(access)}`}
                tone={badge.tone}
              />
            );
          })}
        </div>
      ) : null}

      {discord.error ? (
        <div className="text-xs text-danger">{discord.error}</div>
      ) : lastError ? (
        <div className="text-xs text-danger">{lastError}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function TelegramConnectorCard() {
  const telegram = useTelegramConnector();

  const isConnected = telegram.status?.connected === true;
  const authError = telegram.error;
  const readReady =
    telegram.status?.grantedCapabilities.includes("telegram.read") === true;
  const sendReady =
    telegram.status?.grantedCapabilities.includes("telegram.send") === true;
  const fullyReady = isConnected && readReady && sendReady;
  const busy = telegram.loading;
  const statusLabel =
    telegram.loading && !telegram.status
      ? "Checking..."
      : isConnected
        ? fullyReady
          ? "Connected"
          : readReady
            ? "Connected, send limited"
            : sendReady
              ? "Connected, inbound off"
              : "Connected, capabilities missing"
        : "Managed in Connectors";
  const statusVariant: ConnectorStatusVariant = fullyReady
    ? "ok"
    : isConnected || telegram.setupManagedByPlugin || telegram.loading
      ? "warning"
      : "muted";

  return (
    <ConnectorCardShell
      icon={<TelegramIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="Telegram"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      {!isConnected ? (
        <div className="flex flex-wrap items-center gap-2">
          <ManagedConnectorChip
            platform="Telegram"
            message={telegram.pluginManagedMessage}
          />
          <ConnectorManagementButton
            provider="telegram"
            platform="Telegram"
            disabled={busy}
          />
          <ConnectorActionButton
            agentId="connector-telegram-refresh-managed"
            label="Refresh Telegram"
            description="Refresh Telegram connector status"
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void telegram.refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            {telegram.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
          </ConnectorActionButton>
        </div>
      ) : null}

      {isConnected ? (
        <div className="space-y-2">
          {telegram.status.identity ? (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <Phone className="h-3.5 w-3.5" />
              {String(
                telegram.status.identity.username ||
                  telegram.status.identity.phone ||
                  "",
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorPipSummary
              items={[readReady ? "ok" : "warning", sendReady ? "ok" : "warning"]}
              label={`Telegram read ${readReady ? "ready" : "not ready"}, send ${sendReady ? "ready" : "not ready"}`}
            />
            <ConnectorManagementButton
              provider="telegram"
              platform="Telegram"
              label="Manage"
              disabled={busy}
            />
            <ConnectorActionButton
              agentId="connector-telegram-refresh"
              label="Refresh Telegram"
              description="Refresh Telegram connector status"
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void telegram.refresh()}
              title="Refresh"
              aria-label="Refresh"
            >
              {telegram.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
            </ConnectorActionButton>
          </div>
        </div>
      ) : null}

      {authError ? (
        <div className="text-xs text-danger">{authError}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

export function WhatsAppConnectorCard() {
  const whatsapp = useWhatsAppConnector();
  const status = whatsapp.status;
  const inboundReady = status?.inboundReady === true;
  const outboundReady = status?.outboundReady === true;
  const fullyReady = inboundReady && outboundReady;
  const anyDirectionReady = inboundReady || outboundReady;
  const hasDegradations = Boolean(status?.degradations?.length);
  const localAuthNeedsRepair = status?.localAuthRegistered === false;
  const localAuthUnavailable =
    status?.localAuthAvailable === true && status.serviceConnected !== true;
  const isConnected = status?.connected === true;
  const busy = whatsapp.loading;
  let statusLabel: string;
  if (busy && !status) {
    statusLabel = "Checking...";
  } else if (fullyReady) {
    statusLabel =
      status.transport === "cloudapi"
        ? "Inbound + outbound"
        : "Local session ready";
  } else if (outboundReady) {
    statusLabel = "Outbound only";
  } else if (inboundReady) {
    statusLabel = "Inbound only";
  } else if (localAuthNeedsRepair) {
    statusLabel = "Re-pair required";
  } else if (localAuthUnavailable) {
    statusLabel = "Local session offline";
  } else {
    statusLabel = "Managed in Connectors";
  }
  const statusVariant: ConnectorStatusVariant = fullyReady
    ? "ok"
    : anyDirectionReady ||
        hasDegradations ||
        localAuthNeedsRepair ||
        localAuthUnavailable ||
        busy
      ? "warning"
      : "muted";

  return (
    <ConnectorCardShell
      icon={<WhatsAppIcon className="h-5 w-5 shrink-0 text-muted" />}
      platform="WhatsApp"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      <div className="space-y-2">
        {status?.phoneNumberId ? (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Phone className="h-3.5 w-3.5" />
            {status.phoneNumberId}
          </div>
        ) : null}
        {status ? (
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorPipSummary
              items={[
                inboundReady ? "ok" : "warning",
                outboundReady ? "ok" : "warning",
              ]}
              label={`WhatsApp inbound ${inboundReady ? "ready" : "not ready"}, outbound ${outboundReady ? "ready" : "not ready"}`}
            />
            {status.degradations?.length ? (
              <span
                aria-label={`${status.degradations.length} WhatsApp diagnostics`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600"
                role="img"
                title={status.degradations
                  .map((degradation) => degradation.message)
                  .join("\n")}
              >
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {!isConnected ? (
            <ConnectorManagementButton
              provider="whatsapp"
              platform="WhatsApp"
              disabled={busy}
            />
          ) : null}
          <ConnectorActionButton
            agentId="connector-whatsapp-refresh"
            label="Refresh WhatsApp"
            description="Refresh WhatsApp connector status"
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void whatsapp.refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </ConnectorActionButton>
        </div>
      </div>

      {whatsapp.error ? (
        <div className="text-xs text-danger">{whatsapp.error}</div>
      ) : null}
    </ConnectorCardShell>
  );
}

function formatIMessageSendMode(
  sendMode: "cli" | "private-api" | "apple-script" | "none",
): string {
  switch (sendMode) {
    case "cli":
      return "imsg CLI";
    case "private-api":
      return "Plugin private API";
    case "apple-script":
      return "Messages.app AppleScript";
    default:
      return "Unavailable";
  }
}

function formatIMessageDiagnostic(code: string): string {
  switch (code) {
    case "full_disk_access_required":
      return "Full Disk Access is required before Eliza can read incoming Messages history.";
    case "chat_db_unavailable":
      return "Eliza could not open Messages chat.db for incoming message reads.";
    case "native_bridge_not_connected":
      return "The native Messages bridge is loaded but not connected yet.";
    case "no_backend_available":
    case "imessage_plugin_unavailable":
      return "No local iMessage backend is available.";
    default:
      return code;
  }
}

export function IMessageConnectorCard() {
  const imessage = useIMessageConnector();
  const { setActionNotice } = useApp();
  const status = imessage.status;
  const busy = imessage.loading;
  const isConnected = status?.connected === true;
  const hostPlatform = status?.hostPlatform ?? "unknown";
  const runningOnMacHost = hostPlatform === "darwin";
  const nativeReadDegraded =
    status?.diagnostics.includes("full_disk_access_required") ||
    status?.diagnostics.includes("chat_db_unavailable");
  const isDegraded = Boolean(isConnected && nativeReadDegraded);
  const needsFullDiskAccess = imessage.fullDiskAccess?.status === "revoked";
  const showFullDiskAccessControls =
    runningOnMacHost && (needsFullDiskAccess || nativeReadDegraded);
  const bridgeLabel =
    status?.bridgeType === "native"
      ? "Messages.app"
      : status?.bridgeType === "imsg"
        ? "imsg"
        : null;
  const statusLabel =
    busy && !status
      ? "Checking..."
      : isConnected
        ? bridgeLabel === "Messages.app" && nativeReadDegraded
          ? "Connected, needs Full Disk Access"
          : bridgeLabel
            ? `Connected via ${bridgeLabel}`
            : "Connected"
        : "Not connected";
  const statusVariant: ConnectorStatusVariant = isDegraded
    ? "warning"
    : showFullDiskAccessControls
      ? "warning"
      : isConnected
        ? "ok"
        : busy && !status
          ? "warning"
          : "muted";
  const bridgePips: ConnectorStatusVariant[] = [
    isConnected ? "ok" : "muted",
    nativeReadDegraded ? "warning" : isConnected ? "ok" : "muted",
    status?.sendMode === "apple-script"
      ? "warning"
      : isConnected
        ? "ok"
        : "muted",
  ];

  const handleOpenFullDiskAccess = useCallback(async () => {
    try {
      await openExternalUrl(MACOS_FULL_DISK_ACCESS_SETTINGS_URL);
      setActionNotice(
        "Opened macOS Full Disk Access settings.",
        "success",
        3600,
      );
    } catch (cause) {
      setActionNotice(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Eliza could not open Full Disk Access settings.",
        "error",
        5000,
      );
    }
  }, [setActionNotice]);

  return (
    <ConnectorCardShell
      icon={<MessageCircle className="h-5 w-5 shrink-0 text-muted" />}
      platform="iMessage"
      status={statusLabel}
      statusVariant={statusVariant}
    >
      <div className="space-y-2">
        {showFullDiskAccessControls ? (
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorActionButton
              agentId="connector-imessage-full-disk-access"
              label="Open Full Disk Access"
              description="Open the Full Disk Access settings for iMessage reading"
              size="sm"
              variant="outline"
              className="h-8 w-8 rounded-xl p-0"
              disabled={busy}
              onClick={() => void handleOpenFullDiskAccess()}
              title="Open Full Disk Access"
              aria-label="Open Full Disk Access"
            >
              <HardDrive className="h-3.5 w-3.5" aria-hidden />
            </ConnectorActionButton>
          </div>
        ) : null}
        {status?.accountHandle ? (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Phone className="h-3.5 w-3.5" />
            {status.accountHandle}
          </div>
        ) : null}
        {isConnected ? (
          <div className="flex flex-wrap items-center gap-2">
            <ConnectorPipSummary
              items={bridgePips}
              label={`iMessage ${bridgeLabel ?? "bridge"}, send ${formatIMessageSendMode(status.sendMode)}, read ${nativeReadDegraded ? "limited" : "ready"}`}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <ConnectorActionButton
            agentId="connector-imessage-refresh"
            label="Refresh iMessage"
            description="Refresh iMessage connector status"
            size="sm"
            variant="outline"
            className="h-8 w-8 rounded-xl p-0"
            disabled={busy}
            onClick={() => void imessage.refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
          </ConnectorActionButton>
        </div>
        {status?.error ? (
          <div className="text-xs text-danger">{status.error}</div>
        ) : null}
        {status?.diagnostics.length ? (
          <span
            aria-label={`${status.diagnostics.length} iMessage diagnostics`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600"
            role="img"
            title={status.diagnostics.map(formatIMessageDiagnostic).join("\n")}
          >
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
        {imessage.error ? (
          <div className="text-xs text-danger">{imessage.error}</div>
        ) : null}
      </div>
    </ConnectorCardShell>
  );
}

export function MessagingConnectorGrid() {
  return (
    <div className="space-y-1">
      <div className="space-y-1">
        <SignalConnectorCard />
        <DiscordConnectorCard />
        <WhatsAppConnectorCard />
        <TelegramConnectorCard />
        <IMessageConnectorCard />
      </div>
    </div>
  );
}
